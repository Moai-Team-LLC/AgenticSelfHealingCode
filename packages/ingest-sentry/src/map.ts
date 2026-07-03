/**
 * Sentry webhook → IncidentCandidate mapping (native ingestion). Turns a real Sentry `error`/`issue`/
 * `event_alert` payload into the RAW object shape `normalizeIncidentCandidate` consumes — it re-reads
 * the keys it cares about (id/fingerprint/severity/first_seen/occurrences/affected_service/
 * affected_paths/recent_deploys/shape + title/message/culprit for injection scanning), so we emit
 * exactly those.
 *
 * Purely defensive: every field access tolerates unknown/missing structure and falls back to a safe
 * default — this runs on attacker-reachable input and MUST NOT throw. All text is treated as untrusted
 * data (copied through, never interpreted); the contract's normalizer does the injection flagging.
 */

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object'
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * Sentry `level` → numeric severity (0..1). Sentry levels are an ordered enum; we map to the same
 * 0..1 band the rest of the product uses so an ingested Sentry incident is comparable to other sources.
 * Unknown/missing level defaults to the `error` band.
 */
const LEVEL_SEVERITY: Record<string, number> = {
  fatal: 1,
  error: 0.8,
  warning: 0.5,
  info: 0.3,
  debug: 0.1,
  sample: 0.1,
}
function levelToSeverity(level: unknown): number {
  const key = str(level).toLowerCase()
  return LEVEL_SEVERITY[key] ?? LEVEL_SEVERITY.error!
}

/** First integer-ish `times_seen`/`count`, else 1 (a single occurrence). */
function occurrencesOf(node: Record<string, unknown>): number {
  for (const k of ['times_seen', 'timesSeen', 'count'] as const) {
    const v = node[k]
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
    if (Number.isFinite(n) && n >= 1) return Math.floor(n)
  }
  return 1
}

/** Project slug from either `project_slug` (event alert) or a nested `project.slug` (issue). */
function projectSlug(data: Record<string, unknown>, node: Record<string, unknown>): string {
  const flat = str(data.project_slug) || str(node.project_slug)
  if (flat) return flat
  const proj = isObj(node.project) ? node.project : isObj(data.project) ? data.project : undefined
  return proj ? str(proj.slug) || str(proj.name) : ''
}

/**
 * Best-effort top in-app stack-frame filename. Sentry nests frames at
 * `exception.values[].stacktrace.frames[]`; frames are oldest→newest and `in_app` marks user code.
 * We prefer the last (deepest) in-app frame's `filename`/`abs_path`, falling back to the last frame of
 * the last value. Returns [] when there is no stacktrace.
 */
function affectedPaths(node: Record<string, unknown>): string[] {
  const exc = node.exception
  const values = isObj(exc) && Array.isArray(exc.values) ? exc.values : Array.isArray(exc) ? exc : []
  for (let i = values.length - 1; i >= 0; i--) {
    const val = values[i]
    if (!isObj(val)) continue
    const st = val.stacktrace
    const frames = isObj(st) && Array.isArray(st.frames) ? st.frames : Array.isArray(val.frames) ? val.frames : []
    let fallback = ''
    for (let j = frames.length - 1; j >= 0; j--) {
      const f = frames[j]
      if (!isObj(f)) continue
      const file = str(f.filename) || str(f.abs_path)
      if (!file) continue
      if (f.in_app === true) return [file]
      if (!fallback) fallback = file
    }
    if (fallback) return [fallback]
  }
  return []
}

/** The event/issue node carrying the fields (data.error | data.issue | data.event). */
function pickNode(data: Record<string, unknown>): Record<string, unknown> {
  for (const k of ['error', 'issue', 'event'] as const) {
    if (isObj(data[k])) return data[k] as Record<string, unknown>
  }
  return {}
}

/**
 * Stable grouping id — the value recurrences must collapse onto. For an event this is the ISSUE id
 * (`issue_id` / `groupID`), NEVER the per-occurrence `event_id`. For an issue payload it is the issue's
 * own `id`. Falls back through the available identifiers so a partial payload still groups deterministically.
 */
function groupingId(data: Record<string, unknown>, node: Record<string, unknown>): string {
  return (
    str(node.issue_id) ||
    str(node.groupID) ||
    str(data.issue_id) ||
    (isObj(data.issue) ? str((data.issue as Record<string, unknown>).id) : '') ||
    str(node.id) ||
    ''
  )
}

const isEventNode = (node: Record<string, unknown>): boolean =>
  'event_id' in node || 'issue_id' in node || 'exception' in node

/**
 * Map a decoded Sentry webhook payload to the RAW IncidentCandidate-ish object the contract normalizer
 * consumes. `opts.resource` is the `sentry-hook-resource` header value (advisory — the payload shape is
 * still sniffed). Never throws.
 */
export function sentryWebhookToCandidate(payload: unknown, opts: { resource?: string } = {}): Record<string, unknown> {
  const root = isObj(payload) ? payload : {}
  const data = isObj(root.data) ? root.data : {}
  const node = pickNode(data)

  const grouping = groupingId(data, node)
  const title = str(node.title)
  // error_class: Sentry puts the exception type in metadata.type (falls back to the title's leading token).
  const meta = isObj(node.metadata) ? node.metadata : {}
  const errorClass = str(meta.type) || title.split(':')[0]?.trim() || ''
  // message: prefer metadata.value (the exception message) then the title; guards.ts scans this too.
  const message = str(meta.value) || str(node.message) || title

  return {
    id: grouping,
    fingerprint: grouping,
    affected_service: projectSlug(data, node),
    severity: levelToSeverity(node.level),
    occurrences: occurrencesOf(node),
    affected_paths: affectedPaths(node),
    first_seen: str(node.firstSeen) || str(node.timestamp) || str(node.dateCreated) || str(node.datetime),
    title,
    message,
    culprit: str(node.culprit),
    error_class: errorClass,
    recent_deploys: [], // Sentry webhooks carry no deploy info
    shape: 'unknown',
    resource: opts.resource ?? (isEventNode(node) ? 'event' : 'issue'),
  }
}
