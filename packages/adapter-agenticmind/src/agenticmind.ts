/**
 * AgenticMindIncidentMemory — SHO's incident memory delegated to AgenticMind over its MCP tool
 * contract (CONTRACT.md v1.2.0; input schemas in packages/shared/src/lib/knowledge/mcp-tools.ts of
 * the AgenticMind repo). The transport is an injected `McpCall` — any MCP client works; offline
 * tests inject a fake shaped exactly like the real tool responses.
 *
 * ── The polarity join (design) ────────────────────────────────────────────────────────────────────
 * AgenticMind stores materials + agent beliefs; it does NOT know SHO's OutcomeLabel taxonomy. The
 * adapter therefore splits an incident across two AgenticMind primitives and re-joins at retrieval:
 *
 *   write side
 *     recordIncident(rec, trace)  → kl_ingest  { title: "SHO incident <id> | <moduleArea> | <sig>",
 *                                                text: signal + why-trace } → materialId
 *                                 → mem_write  { subject: <incidentId>, predicate: 'sho:material',
 *                                                object: <materialId> }   (back-reference ledger)
 *     setOutcomeLabel(id, label)  → mem_write  { subject: <incidentId>, predicate: 'sho:outcome',
 *                                                object: <label> }
 *                                   AgenticMind belief revision (same subject+predicate supersedes
 *                                   non-destructively) is exactly SHO's "label is MUTABLE" rule.
 *                                 → kl_signal  on the ask that surfaced the precedent (when known):
 *                                   confirmed_good → 'downstream_success' (+1),
 *                                   recurred|reverted|wrong_rca → 'downstream_failure' (−1).
 *                                   Weak labels emit NO signal — mem_write is the ledger.
 *
 *   read side (retrieveSimilar)
 *     kl_search { q, limit } → hits (materialId, title, snippet, score)
 *       → the SHO-owned title prefix "SHO incident <id> | …" identifies which materials are SHO
 *         incidents and recovers the incidentId + classKey (non-SHO materials are dropped);
 *       → per recovered incidentId: mem_recall { subject: incidentId } → current beliefs; the
 *         'sho:outcome' object (validated against the OutcomeLabel set) is the label — belief
 *         revision guarantees at most one CURRENT label per subject, so the join is unambiguous;
 *       → label → polarity via @sho/incident-memory polarityOf: exemplars vs antiPatterns, ranked
 *         and limited exactly like the in-repo store (positives by score×weight, negatives by
 *         score). Unlabeled SHO materials default to 'proposed' (weakest positive), matching the
 *         "never neutral, never imitate the unproven" rule.
 *
 * Returned hits are PROJECTIONS: AgenticMind owns storage, so record fields it does not hold
 * (fingerprint, timestamps) are zero-valued; the load-bearing fields — outcomeLabel, polarity,
 * similarity, rationaleText — are real. Retrieved text (titles, snippets, answers) is DATA: it is
 * returned to the caller verbatim and never interpreted, executed, or used to choose tool names.
 *
 * Zero runtime deps; no secrets (auth lives inside the injected transport).
 */

import type { OutcomeLabel, WhyTrace } from '@sho/contracts'
import type { IncidentRecord, ResolutionRecord, RetrievalHit, RetrievalResult } from '@sho/incident-memory'
import { POLARITY_WEIGHT, polarityOf } from '@sho/incident-memory'

/** The injected MCP transport: one tool call. Real = any MCP client; tests = a recording fake. */
export type McpCall = (tool: string, args: Record<string, unknown>) => Promise<unknown>

/** The AgenticMind MCP contract line this adapter is written against (CONTRACT.md). */
export const AGENTICMIND_MCP_CONTRACT_VERSION = '1.2.0'

/** Belief predicates this adapter owns (subject = SHO incidentId). */
export const OUTCOME_PREDICATE = 'sho:outcome'
export const MATERIAL_PREDICATE = 'sho:material'

/** kl_ingest schema bounds (mcp-tools.ts): title ≤300, text ≤200_000; kl_search limit ≤50. */
const TITLE_MAX = 300
const TEXT_MAX = 200_000
const SEARCH_LIMIT_MAX = 50

const TITLE_PREFIX = 'SHO incident '

export interface RecordIncidentOpts {
  /** Optional kl_ingest language hint (must be one of AgenticMind's SUPPORTED_LANGUAGES). */
  language?: string
}

export interface AskGlobalResult {
  answer: string
  /** kl_ask_global telemetryId — the askId later kl_signal reinforcement attaches to. */
  askId?: string
  /** Citation projections (data only — never executed). */
  citations: { materialId: string; title: string; snippet: string }[]
}

export class AgenticMindIncidentMemory {
  /** incidentId → telemetryId of the last kl_ask_global made for it (kl_signal join). */
  private readonly askIds = new Map<string, string>()

  constructor(private readonly call: McpCall) {}

  /**
   * Record an incident (+ optional grounded why-trace) as an AgenticMind material, then ledger the
   * incident→material back-reference as a belief. Returns the materialId.
   */
  async recordIncident(rec: IncidentRecord, trace?: WhyTrace, opts?: RecordIncidentOpts): Promise<{ materialId: string }> {
    const title = `${TITLE_PREFIX}${rec.id} | ${rec.moduleArea} | ${rec.symptomSignature}`.slice(0, TITLE_MAX)
    const text = composeIncidentText(rec, trace).slice(0, TEXT_MAX)
    const args: Record<string, unknown> = { title, text }
    if (opts?.language !== undefined) args.language = opts.language
    const res = await this.call('kl_ingest', args)
    const materialId = requireString(res, 'materialId', 'kl_ingest')
    await this.call('mem_write', { subject: rec.id, predicate: MATERIAL_PREDICATE, object: materialId, confidence: 1 })
    return { materialId }
  }

  /**
   * Set the (mutable) SHO outcome label: mem_write the sho:outcome belief (revision supersedes the
   * prior label), and reinforce the surfacing ask via kl_signal for TERMINAL polarities only —
   * confirmed_good → downstream_success (+1), anti-patterns → downstream_failure (−1).
   */
  async setOutcomeLabel(incidentId: string, label: OutcomeLabel, opts?: { askId?: string }): Promise<void> {
    await this.call('mem_write', { subject: incidentId, predicate: OUTCOME_PREDICATE, object: label, confidence: 1 })
    const polarity = polarityOf(label)
    const askId = opts?.askId ?? this.askIds.get(incidentId)
    if (askId === undefined || (polarity !== 'exemplar' && polarity !== 'anti-pattern')) return
    await this.call('kl_signal', {
      askId,
      signal: polarity === 'exemplar' ? 'downstream_success' : 'downstream_failure',
      strength: POLARITY_WEIGHT[label], // +1 confirmed_good; −1 recurred|reverted|wrong_rca
      note: `${OUTCOME_PREDICATE}=${label}`,
    })
  }

  /**
   * Outcome-weighted retrieval over AgenticMind: kl_search, then join each SHO hit's current
   * 'sho:outcome' belief via mem_recall to assign polarity (see the header design). Two separately
   * limited blocks, mirroring the in-repo store: kPos = k, kNeg = opts.kNeg ?? 3.
   */
  async retrieveSimilar(query: string, k: number, opts?: { kNeg?: number }): Promise<RetrievalResult> {
    const kPos = Math.max(1, k)
    const kNeg = opts?.kNeg ?? 3
    const limit = Math.min(SEARCH_LIMIT_MAX, Math.max(10, (kPos + kNeg) * 2))
    const res = await this.call('kl_search', { q: query, limit })
    const rawHits = asArray(asRecord(res)?.hits)

    // Parse SHO-owned hits first (pure), then join labels in parallel (deterministic by index).
    const parsedHits = rawHits.flatMap((raw) => {
      const h = asRecord(raw)
      const materialId = asString(h?.materialId)
      const title = asString(h?.title)
      const snippet = asString(h?.snippet) ?? ''
      const score = typeof h?.score === 'number' ? h.score : null
      if (h === null || materialId === null || title === null || score === null) return []
      const parsed = parseShoTitle(title)
      return parsed === null ? [] : [{ materialId, snippet, score, ...parsed }]
    })
    const labels = await Promise.all(parsedHits.map((h) => this.currentOutcomeLabel(h.incidentId)))

    const exemplars: RetrievalHit[] = []
    const antiPatterns: RetrievalHit[] = []
    parsedHits.forEach((h, i) => {
      const label = labels[i] ?? 'proposed' // unlabeled → weakest positive, never neutral/imitated
      const polarity = polarityOf(label)
      if (polarity === 'neutral') return // superseded — filtered, same as the in-repo store
      const incident: IncidentRecord = {
        id: h.incidentId,
        fingerprint: '', // projection: AgenticMind does not store SHO fingerprints
        symptomSignature: h.symptomSignature,
        moduleArea: h.moduleArea,
        signalText: h.snippet,
        firstSeenMs: 0, // projection: unknown
      }
      const resolution: ResolutionRecord = {
        id: `agenticmind:${h.materialId}`,
        incidentId: h.incidentId,
        classKey: `${h.moduleArea}::${h.symptomSignature}`,
        outcomeLabel: label,
        rationaleText: h.snippet,
        createdAtMs: 0, // projection: unknown
      }
      const hit: RetrievalHit = { resolution, incident, similarity: h.score, weight: POLARITY_WEIGHT[label], polarity }
      if (polarity === 'anti-pattern') antiPatterns.push(hit)
      else exemplars.push(hit)
    })

    // Identical ranking rule to InMemoryIncidentMemory (§4): outcome over activity.
    exemplars.sort((a, b) => b.similarity * b.weight - a.similarity * a.weight)
    antiPatterns.sort((a, b) => b.similarity - a.similarity)
    return { exemplars: exemplars.slice(0, kPos), antiPatterns: antiPatterns.slice(0, kNeg) }
  }

  /**
   * Synthesised precedent ("we fixed this in March") via kl_ask_global. When incidentId is given
   * the returned askId is remembered, so a later setOutcomeLabel reinforces THIS ask via kl_signal.
   * The answer and citations are data — returned verbatim, never executed.
   */
  async askGlobal(question: string, opts?: { incidentId?: string; intent?: string }): Promise<AskGlobalResult> {
    const args: Record<string, unknown> = { question }
    if (opts?.intent !== undefined) args.intent = opts.intent
    const res = await this.call('kl_ask_global', args)
    const rec = asRecord(res)
    const answer = asString(rec?.answer) ?? ''
    const askId = asString(rec?.telemetryId) ?? undefined
    const citations = asArray(rec?.citations).flatMap((raw) => {
      const c = asRecord(raw)
      const materialId = asString(c?.materialId)
      return c === null || materialId === null
        ? []
        : [{ materialId, title: asString(c.title) ?? '', snippet: asString(c.snippet) ?? '' }]
    })
    if (opts?.incidentId !== undefined && askId !== undefined) this.askIds.set(opts.incidentId, askId)
    return { answer, askId, citations }
  }

  /** mem_recall the subject's CURRENT 'sho:outcome' belief; highest confidence wins (ties → later). */
  private async currentOutcomeLabel(incidentId: string): Promise<OutcomeLabel | null> {
    const res = await this.call('mem_recall', { subject: incidentId, includeShared: true, limit: 50 })
    let best: { label: OutcomeLabel; confidence: number } | null = null
    for (const raw of asArray(asRecord(res)?.beliefs)) {
      const b = asRecord(raw)
      if (b === null || b.predicate !== OUTCOME_PREDICATE) continue
      const object = asString(b.object)
      if (object === null || !isOutcomeLabel(object)) continue // hostile/foreign object → ignored, not trusted
      const confidence = typeof b.confidence === 'number' ? b.confidence : 0
      if (best === null || confidence >= best.confidence) best = { label: object, confidence }
    }
    return best?.label ?? null
  }
}

// ── pure helpers ─────────────────────────────────────────────────────────────

/** Compose the kl_ingest text from the incident signal + the grounded why-trace (LOOP-A §5). */
export function composeIncidentText(rec: IncidentRecord, trace?: WhyTrace): string {
  const lines = [
    `Incident ${rec.id} (${rec.moduleArea} :: ${rec.symptomSignature})`,
    `Signal: ${rec.signalText}`,
  ]
  if (trace) {
    lines.push(
      '',
      `Hypothesis: ${trace.hypothesis}`,
      `Alternatives: ${trace.alternatives.join('; ') || '(none)'}`,
      `Correlation: ${trace.correlationState}`,
      `Fix class: ${trace.fixClass}`,
      `Recommended action: ${trace.recommendedAction}`,
      `Affected components: ${trace.affectedComponents.join(', ') || '(none)'}`,
      `Grounded confidence: reproduced=${trace.confidence.reproduced} explainsAllOccurrences=${trace.confidence.explainsAllOccurrences} affectedPathInDeployDiff=${trace.confidence.affectedPathInDeployDiff} stepVsSlopeConsistent=${trace.confidence.stepVsSlopeConsistent}`,
    )
    if (trace.similarIncidents.length > 0) {
      lines.push(`Similar incidents: ${trace.similarIncidents.map((s) => `${s.id}=${s.outcome}`).join(', ')}`)
    }
  }
  return lines.join('\n')
}

/** Recover incidentId/moduleArea/symptomSignature from the SHO-owned title format; null = not ours. */
export function parseShoTitle(title: string): { incidentId: string; moduleArea: string; symptomSignature: string } | null {
  if (!title.startsWith(TITLE_PREFIX)) return null
  const parts = title.slice(TITLE_PREFIX.length).split(' | ')
  const incidentId = parts[0]
  if (parts.length < 3 || incidentId === undefined || incidentId === '') return null
  return { incidentId, moduleArea: parts[1] ?? '', symptomSignature: parts.slice(2).join(' | ') }
}

/** OutcomeLabel guard, keyed off the canonical POLARITY_WEIGHT table (no re-declared label list). */
const isOutcomeLabel = (s: string): s is OutcomeLabel => Object.hasOwn(POLARITY_WEIGHT, s)

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const asString = (v: unknown): string | null => (typeof v === 'string' ? v : null)

function requireString(res: unknown, key: string, tool: string): string {
  const v = asRecord(res)?.[key]
  const s = asString(v)
  if (s === null || s === '') throw new Error(`${tool}: response missing string '${key}'`)
  return s
}
