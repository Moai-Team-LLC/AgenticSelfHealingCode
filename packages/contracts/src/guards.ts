/**
 * Hand-rolled validators for UNTRUSTED input (D7). Signal ingestion is attacker-reachable, so a raw
 * webhook payload must be parsed into a known shape before anything touches it — and telemetry text is
 * data, never instructions (log-borne prompt-injection defense). No external deps by design.
 */

import type { IncidentCandidate, OutcomeEvent, OutcomeEventKind, SignalSource, SignalShape } from './types'

const SOURCES: SignalSource[] = ['sentry', 'otel', 'rum', 'business-metric']
const SHAPES: SignalShape[] = ['step', 'slope', 'spike', 'unknown']
const OUTCOME_KINDS: OutcomeEventKind[] = ['applied', 'recurrence', 'spawn', 'spawn_contested', 'revert', 'matured']

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const isoOrNull = (v: unknown): string | null => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null)

/** Text that looks like it's addressing the agent — flagged so downstream never treats it as a command. */
const INJECTION_RE =
  /\b(ignore (all|previous)|disregard|system prompt|you are now|assistant:|tool_call|<\/?(system|instructions?)>|run the following|execute this)\b/i

export function looksLikeInjection(text: string): boolean {
  return INJECTION_RE.test(text)
}

export interface NormalizeResult { candidate: IncidentCandidate; suspicious: boolean }

/**
 * Parse an untrusted payload into an IncidentCandidate. Unknown/missing fields get safe defaults;
 * `suspicious` is set if any free-text field contains instruction-like content (surfaced downstream,
 * never acted on). Does NOT execute or interpret any field.
 */
export function normalizeIncidentCandidate(raw: unknown, source: SignalSource): NormalizeResult {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const source_ = SOURCES.includes(source) ? source : 'otel'
  const paths = Array.isArray(o.affected_paths) ? o.affected_paths.filter((p): p is string => typeof p === 'string') : []
  const deploys = Array.isArray(o.recent_deploys)
    ? o.recent_deploys
        .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object')
        .map((d) => ({ deploy_id: str(d.deploy_id), ts: isoOrNull(d.ts) ?? '', diff_url: typeof d.diff_url === 'string' ? d.diff_url : undefined }))
        .filter((d) => d.deploy_id && d.ts)
    : []
  const shape = SHAPES.includes(o.shape as SignalShape) ? (o.shape as SignalShape) : 'unknown'

  const textFields = [str(o.title), str(o.message), str(o.culprit), ...paths]
  const suspicious = textFields.some((t) => t && looksLikeInjection(t))

  const candidate: IncidentCandidate = {
    id: str(o.id) || str(o.fingerprint) || crypto.randomUUID(),
    source: source_,
    fingerprint: str(o.fingerprint) || str(o.id),
    severity: num(o.severity),
    first_seen: isoOrNull(o.first_seen) ?? isoOrNull(o.firstSeen) ?? new Date().toISOString(),
    occurrences: num(o.occurrences, 1),
    affected_service: str(o.affected_service) || str(o.service),
    affected_paths: paths,
    recent_deploys: deploys,
    shape,
    raw_payload: raw,
  }
  return { candidate, suspicious }
}

export function isOutcomeEvent(v: unknown): v is OutcomeEvent {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o.actionId === 'string' && OUTCOME_KINDS.includes(o.kind as OutcomeEventKind) && isoOrNull(o.at) !== null
}
