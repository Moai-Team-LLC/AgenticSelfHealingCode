/**
 * The apply-time writer + auto_action store (ARCHITECTURE-REFRAMED §3.2, coherence BLOCKER #3/#5).
 *
 * This is the write path the trust ladder was "dead on arrival" without: it inserts exactly one
 * orch.auto_action row when a change LANDS — for BOTH `machine` (auto-apply) and `human_approved` (an
 * L1 PR merge, the `assisted_action` the promotion ladder needs). Idempotent on (incident_id, fix_sha)
 * so redelivery is a no-op (never an orphan row, never the resolutions freeze-trigger throw).
 */

import type { AutoAction, GateResult, OutcomeEvent } from '@sho/contracts'

export interface LandingInput {
  incident_id: string
  class_key: string
  loop: 'B' | 'C'
  applied_by: 'machine' | 'human_approved'
  fix_sha: string
  parent_sha: string
  gate_result: GateResult
  accountable_owner: string // = trust_class.owner (D9); the writer materializes it frozen
  module_area: string
  applied_at?: string
}

export interface AutoActionStore {
  insert(row: AutoAction): void
  getByIncidentFix(incidentId: string, fixSha: string): AutoAction | undefined
  listByClass(classKey: string): AutoAction[]
  listByArea(moduleArea: string): AutoAction[]
  get(actionId: string): AutoAction | undefined
}

export class InMemoryAutoActionStore implements AutoActionStore {
  private byId = new Map<string, AutoAction>()
  private byIncidentFix = new Map<string, AutoAction>()
  private key(i: string, f: string) { return `${i}::${f}` }
  insert(row: AutoAction): void {
    this.byId.set(row.action_id, row)
    this.byIncidentFix.set(this.key(row.incident_id, row.fix_sha), row)
  }
  getByIncidentFix(i: string, f: string) { return this.byIncidentFix.get(this.key(i, f)) }
  listByClass(classKey: string) { return [...this.byId.values()].filter((a) => a.class_key === classKey) }
  listByArea(moduleArea: string) { return [...this.byId.values()].filter((a) => a.module_area === moduleArea) }
  get(actionId: string) { return this.byId.get(actionId) }
}

export interface ApplyTimeResult { action: AutoAction; created: boolean }

/**
 * Insert-or-return the landing record. `linkResolution` (optional) links the incident-memory resolution
 * to this actionId — but only on first create (the freeze trigger makes re-linking an error, so we don't).
 */
export function applyTimeWrite(
  store: AutoActionStore,
  input: LandingInput,
  linkResolution?: (actionId: string) => void,
): ApplyTimeResult {
  const existing = store.getByIncidentFix(input.incident_id, input.fix_sha)
  if (existing) return { action: existing, created: false } // idempotent

  const action: AutoAction = {
    action_id: crypto.randomUUID(),
    incident_id: input.incident_id,
    class_key: input.class_key,
    loop: input.loop,
    applied_by: input.applied_by,
    applied_at: input.applied_at ?? new Date().toISOString(),
    fix_sha: input.fix_sha,
    parent_sha: input.parent_sha,
    gate_result: input.gate_result,
    accountable_owner: input.accountable_owner,
    module_area: input.module_area,
  }
  store.insert(action)
  linkResolution?.(action.action_id)
  return { action, created: true }
}

/** Project the store's landings into `applied` OutcomeEvents (the rest come from incident-memory). */
export function appliedEvents(store: AutoActionStore, classKey: string): OutcomeEvent[] {
  return store.listByClass(classKey).map((a) => ({ actionId: a.action_id, kind: 'applied' as const, at: a.applied_at }))
}
