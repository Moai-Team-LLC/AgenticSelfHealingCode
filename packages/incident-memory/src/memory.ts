/**
 * InMemoryIncidentMemory — Map-based reference implementation of the IncidentMemory port. It is the
 * decision logic the spec cares about (outcome-weighted retrieval §4, the maturation/projection seam
 * §5.3/§7, drift-resistant recurrence §6, the harm metric §7.3). The Postgres adapter (postgres.ts) is
 * a thin translation of these same rules onto an injected executor.
 *
 * Determinism: every method that needs "now" takes nowMs; iteration order is insertion order (Map).
 */

import type { OutcomeEvent, OutcomeLabel, IncidentCandidate } from '@sho/contracts'
import { WINDOWS_DAYS } from '@sho/contracts'
import { tokenOverlap } from './similarity'
import { POLARITY_WEIGHT, polarityOf } from './polarity'
import type {
  IncidentMemory,
  IncidentRecord,
  ResolutionRecord,
  RetrievalHit,
  RetrievalResult,
  RetrieveOpts,
  RecurrenceResult,
  VectorMatchFn,
} from './types'

const DAY = 86_400_000

/** Labels a projector maps onto a terminal controller OutcomeEvent (§5.4). Others emit no terminal event. */
const TERMINAL_KIND: Partial<Record<OutcomeLabel, OutcomeEvent['kind']>> = {
  confirmed_good: 'matured',
  recurred: 'recurrence',
  reverted: 'revert',
}

/** Caused labels for the harm metric (§7.3) — the retrieval-facing projection of recurrence/revert. */
const CAUSED_LABELS: ReadonlySet<OutcomeLabel> = new Set<OutcomeLabel>(['recurred', 'reverted'])

export class InMemoryIncidentMemory implements IncidentMemory {
  private readonly incidents = new Map<string, IncidentRecord>()
  private readonly resolutions = new Map<string, ResolutionRecord>()

  recordIncident(rec: IncidentRecord): void {
    this.incidents.set(rec.id, { ...rec })
  }

  recordResolution(rec: ResolutionRecord): void {
    this.resolutions.set(rec.id, { ...rec })
  }

  setOutcomeLabel(resolutionId: string, label: OutcomeLabel): void {
    const r = this.resolutions.get(resolutionId)
    if (!r) throw new Error(`setOutcomeLabel: unknown resolution ${resolutionId}`)
    // Enforcement (§5.2): confirmed_good is the ONLY positive exemplar and, for code resolutions, is
    // earned by maturation — it must not be stamped on a resolution that never landed (no actionId).
    if (label === 'confirmed_good' && r.actionId === undefined) {
      throw new Error(`confirmed_good requires a landed action (actionId); rca-only rows mature via provisional_human_confirmed`)
    }
    r.outcomeLabel = label
  }

  /**
   * Outcome-weighted retrieval (§4, attack #8). Rank candidates by the injected similarity fn, then
   * split into two separately-limited blocks by polarity. A failed resolution is NEVER a neutral match:
   * it is surfaced in the anti-pattern block, labeled. `superseded`/neutral rows are filtered out.
   */
  retrieveSimilar(query: string, k: number, opts: RetrieveOpts = {}): RetrievalResult {
    const sim = opts.similarity ?? tokenOverlap
    const kPos = opts.kPos ?? k ?? 5
    const kNeg = opts.kNeg ?? 3
    const minSim = opts.minSimilarity ?? 0

    const exemplars: RetrievalHit[] = []
    const antiPatterns: RetrievalHit[] = []

    // exactly one row per incident: the current, non-superseded resolution (§4 dedup).
    for (const r of this.currentResolutions()) {
      const inc = this.incidents.get(r.incidentId)
      if (!inc) continue
      const polarity = polarityOf(r.outcomeLabel)
      if (polarity === 'neutral') continue // superseded / unknown — never returned as a neutral match
      const similarity = sim(query, r.rationaleText || inc.signalText)
      if (similarity < minSim) continue
      const hit: RetrievalHit = { resolution: r, incident: inc, similarity, weight: POLARITY_WEIGHT[r.outcomeLabel], polarity }
      if (polarity === 'anti-pattern') antiPatterns.push(hit)
      else exemplars.push(hit) // exemplar | weak
    }

    // Positives rank by similarity * weight so confirmed_good outranks a merely-recent weak positive
    // at equal similarity (D6: outcome over activity). Negatives rank by raw similarity within-block.
    exemplars.sort((a, b) => b.similarity * b.weight - a.similarity * a.weight)
    antiPatterns.sort((a, b) => b.similarity - a.similarity)
    return { exemplars: exemplars.slice(0, kPos), antiPatterns: antiPatterns.slice(0, kNeg) }
  }

  /**
   * Project a class's resolutions into the controller's OutcomeEvent stream (§7). Idempotent and keyed
   * on actionId: every landed resolution emits `applied`; a terminal event is emitted per §5.4, and
   * `matured` is withheld until appliedAt + W_mature (§5.3 — never on a green run, never early).
   */
  projectOutcomeEvents(classKey: string, nowMs: number): OutcomeEvent[] {
    const events: OutcomeEvent[] = []
    const seenApplied = new Set<string>()
    for (const r of this.resolutions.values()) {
      if (r.classKey !== classKey || r.actionId === undefined) continue // Loop A rca-only never emits (§7.1)
      const actionId = r.actionId
      // `applied` opens the pending window; idempotent per actionId.
      if (!seenApplied.has(actionId)) {
        seenApplied.add(actionId)
        events.push({ actionId, kind: 'applied', at: iso(r.appliedAtMs ?? r.createdAtMs) })
      }
      const kind = TERMINAL_KIND[r.outcomeLabel]
      if (!kind) continue
      if (kind === 'matured') {
        // maturation defers to W_mature; do NOT emit a premature matured (boundary-race defense).
        if (r.appliedAtMs === undefined || nowMs - r.appliedAtMs < WINDOWS_DAYS.W_mature * DAY) continue
        events.push({ actionId, kind, at: iso(r.appliedAtMs + WINDOWS_DAYS.W_mature * DAY) })
      } else {
        // recurrence/revert are detected facts; timestamp them at reconcile-time `nowMs`.
        events.push({ actionId, kind, at: iso(nowMs) })
      }
    }
    return events
  }

  /**
   * Drift-resistant recurrence (§6/§7). Tries the rung hierarchy in order and STOPS at the first hit,
   * but never concludes "no recurrence" without exhausting all rungs (incl. the injected vector fn) —
   * a recurrence hidden by a refactor is exactly how a wrong fix would falsely mature (§5.3).
   */
  detectRecurrence(incident: IncidentCandidate, nowMs: number, vectorMatch?: VectorMatchFn): RecurrenceResult {
    const windowMs = WINDOWS_DAYS.W_recur * DAY
    const sig = symptomSignatureOf(incident)
    const area = moduleAreaOf(incident)
    let vectorHit: string | null = null
    for (const prior of this.incidents.values()) {
      // recurrence is attributed within W_recur (§7); a prior outside the window is not a recurrence.
      if (prior.firstSeenMs > nowMs || nowMs - prior.firstSeenMs > windowMs) continue
      // rung 1 — exact fingerprint (brittle, breaks on any refactor)
      if (prior.fingerprint && prior.fingerprint === incident.fingerprint) {
        return { recurred: true, priorIncidentId: prior.id, basis: 'fingerprint' }
      }
      // rung 2 — symptom_signature + module_area (rename-proof, coarsest structured key)
      if (prior.symptomSignature && prior.symptomSignature === sig && prior.moduleArea && prior.moduleArea === area) {
        return { recurred: true, priorIncidentId: prior.id, basis: 'symptom_area' }
      }
      // rung 3 — vector fallback (last resort); remembered but not returned until structured rungs miss
      if (vectorHit === null && vectorMatch && vectorMatch(prior, incident)) {
        vectorHit = prior.id
      }
    }
    if (vectorHit !== null) return { recurred: true, priorIncidentId: vectorHit, basis: 'vector' }
    return { recurred: false, priorIncidentId: null, basis: null }
  }

  /**
   * Harm count for a class (§7.3): caused resolutions (recurred|reverted) that carry an actionId — which
   * covers BOTH applied_by variants, since orch.auto_action sets action_id for machine AND
   * human_approved landings. Deduped per actionId (one bad fix that recurs twice is one caused-action).
   */
  harmQuery(classKey: string): number {
    const causedActions = new Set<string>()
    for (const r of this.resolutions.values()) {
      if (r.classKey !== classKey || r.actionId === undefined) continue
      if (CAUSED_LABELS.has(r.outcomeLabel)) causedActions.add(r.actionId)
    }
    return causedActions.size
  }

  /** Current, non-superseded resolution per incident (§4): keep the newest non-superseded row. */
  private *currentResolutions(): Iterable<ResolutionRecord> {
    const byIncident = new Map<string, ResolutionRecord>()
    for (const r of this.resolutions.values()) {
      if (r.supersededBy !== undefined || r.outcomeLabel === 'superseded') continue
      const cur = byIncident.get(r.incidentId)
      if (!cur || r.createdAtMs > cur.createdAtMs) byIncident.set(r.incidentId, r)
    }
    yield* byIncident.values()
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

const iso = (ms: number): string => new Date(ms).toISOString()

/**
 * Deriving the drift-resistant keys from a raw IncidentCandidate. The candidate carries a fingerprint
 * and affected_paths; the symptom_signature (error-class + message-shape) and module_area (dir at fixed
 * depth) are what survive a refactor. Kept here (not in the store) so both rungs use one derivation.
 */
export function symptomSignatureOf(c: IncidentCandidate): string {
  const errClass = (c.raw_payload && typeof c.raw_payload === 'object' && 'error_class' in c.raw_payload
    ? String((c.raw_payload as Record<string, unknown>).error_class)
    : '') || firstToken(c.fingerprint)
  const msgShape = normalizeMessageShape(String((c.raw_payload as Record<string, unknown> | null)?.message ?? c.fingerprint))
  return `${errClass}::${msgShape}`
}

export function moduleAreaOf(c: IncidentCandidate, depth = 2): string {
  const p = c.affected_paths[0]
  if (p) return p.split('/').slice(0, depth).join('/')
  return c.affected_service // §10: fall back from service when paths are empty
}

const firstToken = (s: string): string => s.split(/[^a-z0-9]+/i)[0] ?? ''
/** Collapse ids/numbers so the shape generalizes across occurrences (mirrors §3 hygiene, structurally). */
const normalizeMessageShape = (s: string): string => s.replace(/[0-9a-f]{8,}/gi, '<id>').replace(/\d+/g, '<n>').trim()
