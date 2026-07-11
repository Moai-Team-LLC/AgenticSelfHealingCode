/**
 * The CONFIRM path (LOOP-C-DEFERRED.md §5.1). A human confirmed the proposed fix — by merging the PR OR by
 * tapping approve in Telegram. BOTH channels route through this one function, so the landing they produce is
 * provably identical: CAS the approval to APPROVED (descriptive verdict), then write the SINGLE immutable
 * `human_approved` landing. Idempotent on (incident_id, fix_sha) — if both channels fire (merge webhook + a
 * tap), the second is a no-op, never a double landing.
 *
 * The landing store is polymorphic: the in-memory `AutoActionStore` (fakes/tests) and the durable
 * `PgAutoActionStore` (survives restart) both satisfy `LandingStore`, so `confirmRepair` awaits either. That
 * durability matters — the `human_approved` row is the "assisted_action" the promotion ladder folds (D6), so
 * it must outlive the process, exactly like the rest of the orchestrator state. Loop C still NEVER decides its
 * own autonomy; it only records that a human approved a gated diff.
 */

import type { AutoAction, GateResult, TelemetrySink } from '@sho/contracts'
import type { ApprovalQueue, ApprovalRequest } from '@sho/hitl'
import type { ApplyTimeResult } from '@sho/orchestrator'

/** The minimal store surface the landing needs — satisfied by InMemoryAutoActionStore AND PgAutoActionStore. */
export interface LandingStore {
  getByIncidentFix(incidentId: string, fixSha: string): (AutoAction | undefined) | Promise<AutoAction | undefined>
  insert(row: AutoAction): void | Promise<void>
}

export interface ConfirmDeps {
  approvals: ApprovalQueue
  store: LandingStore
  nowMs: number
  /** link the incident-memory resolution to the new actionId (first-create only; §3.2 freeze trigger). */
  linkResolution?: (actionId: string) => void | Promise<void>
  telemetry?: TelemetrySink
}

export interface ConfirmInput {
  approvalId: string
  verdictBy: string // who approved — DESCRIPTIVE audit only (§4.3), never the accountable owner
  parentSha: string
  moduleArea: string
  classKey: string
  accountableOwner: string // = trust_class.owner (D9) — required; a landing must have an owner
  gateResult: GateResult // the GateResult that cleared this fix (frozen into the landing)
  /** the sha actually merged (PR channel), if it differs from the proposed fix (a human edit). */
  mergedFixSha?: string
}

/**
 * Confirm a Loop C repair → write the human_approved landing. Throws if the approval is missing, is not a
 * Loop C request, is in a non-confirmable terminal state, or has no accountable owner. Safe to call twice
 * (idempotent landing) — that is how the two confirm channels coexist without double-writing.
 */
export async function confirmRepair(input: ConfirmInput, deps: ConfirmDeps): Promise<ApplyTimeResult> {
  if (!input.accountableOwner.trim()) {
    throw new Error('confirmRepair: accountableOwner (trust_class.owner, D9) is required — a landing must have an owner')
  }
  const row = deps.approvals.get(input.approvalId)
  if (!row) throw new Error(`confirmRepair: approval_request ${input.approvalId} not found`)
  if (row.loop !== 'C') throw new Error(`confirmRepair: approval ${input.approvalId} is loop ${row.loop}, not a Loop C repair`)

  // CAS to APPROVED if still open; approve() itself guards terminal states. A re-confirm on an already-
  // APPROVED row skips the CAS and falls through to the idempotent landing write.
  if (row.state === 'OPEN' || row.state === 'ESCALATED') {
    deps.approvals.approve(input.approvalId, input.verdictBy, deps.nowMs, input.mergedFixSha)
  } else if (row.state !== 'APPROVED') {
    throw new Error(`confirmRepair: approval ${input.approvalId} is ${row.state}; cannot confirm`)
  }

  const fixSha = input.mergedFixSha ?? row.fixSha
  if (!fixSha) throw new Error(`confirmRepair: approval ${input.approvalId} has no fix_sha to land`)

  // Idempotent apply-time write, polymorphic over sync/async stores. Re-read after insert so a concurrent
  // writer (Pg ON CONFLICT) that won the row is honored — only the canonical creator links the resolution.
  const existing = await deps.store.getByIncidentFix(row.incidentId, fixSha)
  if (existing) return { action: existing, created: false }
  const action: AutoAction = {
    action_id: crypto.randomUUID(),
    incident_id: row.incidentId,
    class_key: input.classKey,
    loop: 'C',
    applied_by: 'human_approved', // the assisted_action the promotion ladder needs (§5.1, D6)
    applied_at: new Date(deps.nowMs).toISOString(),
    fix_sha: fixSha,
    parent_sha: input.parentSha,
    gate_result: input.gateResult,
    accountable_owner: input.accountableOwner, // = trust_class.owner (D9), frozen here
    module_area: input.moduleArea,
  }
  await deps.store.insert(action) // idempotent at the store (in-memory map / Pg ON CONFLICT DO NOTHING)
  const canonical = (await deps.store.getByIncidentFix(row.incidentId, fixSha)) ?? action
  const created = canonical.action_id === action.action_id
  if (created) {
    await deps.linkResolution?.(action.action_id)
    void deps.telemetry?.emit({
      kind: 'trust_transition',
      at: new Date(deps.nowMs).toISOString(),
      classKey: input.classKey,
      incidentId: row.incidentId,
      data: { event: 'human_approved_landing', loop: 'C', actionId: action.action_id, verdictBy: input.verdictBy },
    })
  }
  return { action: canonical, created }
}

/** A human rejected the proposal (closed the PR / tapped reject). No landing; the approval goes REJECTED. */
export function rejectRepair(
  approvalId: string,
  verdictBy: string,
  deps: Pick<ConfirmDeps, 'approvals' | 'nowMs'>,
): ApprovalRequest {
  return deps.approvals.reject(approvalId, verdictBy, deps.nowMs)
}
