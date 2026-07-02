/**
 * Linear → IncidentRecord adapter.
 *
 * Linear records detection/ack/resolve, and — crucially — the TIMESTAMP OF EACH WORKFLOW-STATE
 * TRANSITION in issue history. So if your incident workflow has a "Root cause found" state, Linear
 * knows cause_confirmed_at; if it has a "Deployed" state, it knows fix_deployed_at. This adapter maps
 * state-transition history to the D10 contract via a configurable state-name map. States your workflow
 * lacks → the field stays undefined, and D10 honestly reports those incidents as non-decomposable.
 *
 * Pure over a parsed GraphQL response shape; connectors/linear-pull.ts fetches it.
 */

import type { IncidentRecord } from '../d10'

export interface LinearStateMap {
  acknowledged?: string[]
  causeConfirmed?: string[]
  fixDeployed?: string[]
  resolved?: string[]
}

interface LinearHistoryNode { createdAt?: string; toState?: { name?: string } | null }
export interface LinearIssue {
  identifier?: string
  title?: string
  createdAt?: string
  startedAt?: string
  completedAt?: string
  team?: { key?: string } | null
  labels?: { nodes?: { name?: string }[] } | null
  history?: { nodes?: LinearHistoryNode[] } | null
}

const RESOLUTION_LABELS = new Set(['code_fix', 'rollback', 'config', 'infra', 'data', 'no_action'])

/** Earliest history transition into any of `names` (case-insensitive). */
function firstEntryInto(history: LinearHistoryNode[] | undefined, names: string[] | undefined): string | undefined {
  if (!history || !names || names.length === 0) return undefined
  const want = new Set(names.map((n) => n.trim().toLowerCase()))
  let best: number | undefined
  for (const h of history) {
    const name = h.toState?.name?.trim().toLowerCase()
    if (!name || !want.has(name) || !h.createdAt) continue
    const ms = Date.parse(h.createdAt)
    if (Number.isFinite(ms) && (best === undefined || ms < best)) best = ms
  }
  return best === undefined ? undefined : new Date(best).toISOString()
}

export function linearToIncidents(issues: LinearIssue[], map: LinearStateMap): IncidentRecord[] {
  return issues.map((i) => {
    const rec: IncidentRecord = { id: i.identifier ?? '' }
    if (i.team?.key) rec.service = i.team.key
    if (i.createdAt) rec.detected_at = i.createdAt

    const h = i.history?.nodes
    const ack = firstEntryInto(h, map.acknowledged) ?? i.startedAt
    if (ack) rec.acknowledged_at = ack
    const cause = firstEntryInto(h, map.causeConfirmed)
    if (cause) rec.cause_confirmed_at = cause
    const fix = firstEntryInto(h, map.fixDeployed) ?? i.completedAt
    if (fix) rec.fix_deployed_at = fix
    const resolved = firstEntryInto(h, map.resolved) ?? i.completedAt
    if (resolved) rec.resolved_at = resolved

    const label = i.labels?.nodes?.map((l) => l.name?.trim().toLowerCase()).find((n) => n && RESOLUTION_LABELS.has(n))
    if (label) rec.resolution_type = label

    return rec
  }).filter((r) => r.id)
}

/** Parse the LINEAR_STATE_* env vars into a LinearStateMap (comma-separated names). */
export function stateMapFromEnv(env: Record<string, string | undefined>): LinearStateMap {
  const split = (v?: string) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined)
  return {
    acknowledged: split(env.LINEAR_STATE_ACKNOWLEDGED),
    causeConfirmed: split(env.LINEAR_STATE_CAUSE_CONFIRMED),
    fixDeployed: split(env.LINEAR_STATE_FIX_DEPLOYED),
    resolved: split(env.LINEAR_STATE_RESOLVED),
  }
}
