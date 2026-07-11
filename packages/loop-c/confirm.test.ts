import { test, expect } from 'bun:test'
import { InMemoryTelemetry } from '@sho/contracts'
import { ApprovalQueue } from '@sho/hitl'
import { InMemoryAutoActionStore } from '@sho/orchestrator'
import { confirmRepair, rejectRepair, fakeGateResult, type ConfirmInput, type ConfirmDeps } from './src/index'

/** Enqueue an OPEN loop-C L1 approval (as runRepair would have) and return the id + wiring. */
function proposed(nowMs = 1_000) {
  const approvals = new ApprovalQueue()
  const store = new InMemoryAutoActionStore()
  const telemetry = new InMemoryTelemetry()
  approvals.enqueue(
    {
      id: 'appr-1', incidentId: 'inc-1', classKey: 'src/checkout::TypeError', loop: 'C', tier: 2,
      requestedLevel: 1, whyTraceId: 'inc-1', team: 'checkout', primaryApprover: 'p', secondaryApprover: 's',
      fixSha: 'fix11111', parentSha: 'parent00',
    },
    nowMs,
  )
  const deps: ConfirmDeps = { approvals, store, nowMs, telemetry }
  const input: ConfirmInput = {
    approvalId: 'appr-1', verdictBy: 'oncall_jane', parentSha: 'parent00', moduleArea: 'src/checkout',
    classKey: 'src/checkout::TypeError', accountableOwner: 'team-checkout', gateResult: fakeGateResult(),
  }
  return { approvals, store, telemetry, deps, input }
}

test('confirm a proposed repair → writes a human_approved loop-C landing', async () => {
  const { store, deps, input, approvals } = proposed()
  const res = await confirmRepair(input, deps)

  expect(res.created).toBe(true)
  expect(res.action.applied_by).toBe('human_approved')
  expect(res.action.loop).toBe('C')
  expect(res.action.fix_sha).toBe('fix11111')
  expect(res.action.accountable_owner).toBe('team-checkout') // = trust_class.owner (D9), NOT the approver
  expect(store.listByClass('src/checkout::TypeError')).toHaveLength(1)
  // approval CAS'd to APPROVED with the approver as DESCRIPTIVE verdictBy only
  expect(approvals.get('appr-1')!.state).toBe('APPROVED')
  expect(approvals.get('appr-1')!.verdictBy).toBe('oncall_jane')
})

test('both channels (PR merge + Telegram tap) → ONE landing (idempotent), never a double write', async () => {
  const { store, deps, input } = proposed()
  // Channel 1: the GitHub PR-merge webhook confirms with the merged sha.
  const first = await confirmRepair({ ...input, verdictBy: 'github:merge', mergedFixSha: 'fix11111' }, deps)
  // Channel 2: the on-call also taps approve in Telegram a moment later.
  const second = await confirmRepair({ ...input, verdictBy: 'oncall_jane' }, deps)

  expect(first.created).toBe(true)
  expect(second.created).toBe(false) // idempotent on (incident_id, fix_sha)
  expect(first.action.action_id).toBe(second.action.action_id)
  expect(store.listByClass('src/checkout::TypeError')).toHaveLength(1)
})

test('a merged edit (different sha) lands the merged sha, not the proposed one', async () => {
  const { store, deps, input } = proposed()
  const res = await confirmRepair({ ...input, verdictBy: 'github:merge', mergedFixSha: 'edited99' }, deps)
  expect(res.action.fix_sha).toBe('edited99')
  expect((await store.getByIncidentFix('inc-1', 'edited99'))!.fix_sha).toBe('edited99')
})

test('confirm requires an accountable owner (D9) — empty owner rejects, no landing', async () => {
  const { store, deps, input } = proposed()
  await expect(confirmRepair({ ...input, accountableOwner: '   ' }, deps)).rejects.toThrow(/accountableOwner/)
  expect(store.listByClass('src/checkout::TypeError')).toHaveLength(0)
})

test('reject → approval REJECTED, no landing; a later confirm on it rejects', async () => {
  const { store, deps, input, approvals } = proposed()
  rejectRepair('appr-1', 'oncall_jane', deps)
  expect(approvals.get('appr-1')!.state).toBe('REJECTED')
  expect(store.listByClass('src/checkout::TypeError')).toHaveLength(0)
  await expect(confirmRepair(input, deps)).rejects.toThrow(/REJECTED/)
})

test('confirm on an unknown approval rejects', async () => {
  const { deps, input } = proposed()
  await expect(confirmRepair({ ...input, approvalId: 'nope' }, deps)).rejects.toThrow(/not found/)
})
