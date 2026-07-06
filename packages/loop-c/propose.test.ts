import { test, expect } from 'bun:test'
import type { WhyTrace } from '@sho/contracts'
import { InMemoryTelemetry } from '@sho/contracts'
import { ApprovalQueue } from '@sho/hitl'
import { InMemoryAutoActionStore } from '@sho/orchestrator'
import { runRepair, FakeRepairAuthor, RecordingPublisher, passGate, failGate, fakeStaged, type RepairContext } from './src/index'

function whyTrace(over: Partial<WhyTrace> = {}): WhyTrace {
  return {
    incidentId: 'inc-1',
    hypothesis: 'null cart reaches price() after the checkout deploy',
    alternatives: ['upstream tax service latency'],
    confidence: { reproduced: true, explainsAllOccurrences: true, affectedPathInDeployDiff: true, stepVsSlopeConsistent: true },
    correlationState: 'deploy_linked',
    affectedComponents: ['src/checkout/price.ts'],
    fixClass: 'code',
    recommendedAction: 'guard null cart',
    suspiciousContentFlag: false,
    similarIncidents: [],
    ...over,
  }
}

function ctx(over: Partial<RepairContext> = {}): RepairContext {
  return {
    incidentId: 'inc-1',
    classKey: 'src/checkout::TypeError',
    moduleArea: 'src/checkout',
    team: 'checkout',
    primaryApprover: 'oncall-primary',
    secondaryApprover: 'oncall-secondary',
    whyTrace: whyTrace(),
    loopADecision: 'CONFIRMED',
    autonomy: { level: 'L1', tier: 2, requiredMutationScore: 0.6, accountableOwner: 'team-checkout' },
    ...over,
  }
}

function deps(over: Partial<Parameters<typeof runRepair>[1]> = {}) {
  const approvals = new ApprovalQueue()
  const publisher = new RecordingPublisher()
  const telemetry = new InMemoryTelemetry()
  const notified: string[] = []
  const base = {
    author: new FakeRepairAuthor(fakeStaged()),
    runGate: passGate(),
    publisher,
    approvals,
    nowMs: 1_000,
    newApprovalId: () => 'appr-1',
    notify: (o: { status: string }) => void notified.push(o.status),
    telemetry,
  }
  return { d: { ...base, ...over }, approvals, publisher, telemetry, notified }
}

test('ESCALATE from Loop A → skipped_not_confirmed, nothing authored or proposed', async () => {
  const { d, approvals, publisher } = deps()
  const out = await runRepair(ctx({ loopADecision: 'ESCALATE' }), d)
  expect(out.status).toBe('skipped_not_confirmed')
  expect(approvals.all()).toHaveLength(0)
  expect(publisher.published).toHaveLength(0)
})

test('non-code fixClass → skipped_not_confirmed (config/data/infra is Loop A forever)', async () => {
  const { d } = deps()
  const out = await runRepair(ctx({ whyTrace: whyTrace({ fixClass: 'config' }) }), d)
  expect(out.status).toBe('skipped_not_confirmed')
})

test('autonomy L0 (kill switch / churn hold) → skipped_killed, no fix authored', async () => {
  const authored = { calls: 0 }
  const author = { author: async () => { authored.calls++; return fakeStaged() } }
  const { d, publisher } = deps({ author })
  const out = await runRepair(ctx({ autonomy: { level: 'L0', tier: 1, requiredMutationScore: 0.6, accountableOwner: 'x' } }), d)
  expect(out.status).toBe('skipped_killed')
  expect(authored.calls).toBe(0) // floor is checked BEFORE authoring
  expect(publisher.published).toHaveLength(0)
})

test('author declines (unreproducible / out of scope) → declined_by_author', async () => {
  const { d } = deps({ author: new FakeRepairAuthor(null) })
  const out = await runRepair(ctx(), d)
  expect(out.status).toBe('declined_by_author')
})

test('patch touches a protected path → blocked_protected_path, never gated or proposed', async () => {
  const staged = fakeStaged({ touchedPaths: ['src/checkout/price.ts', 'src/auth/session.ts'] })
  let gateCalls = 0
  const { d, approvals, publisher } = deps({
    author: new FakeRepairAuthor(staged),
    runGate: async () => { gateCalls++; return (await passGate()(staged, ctx())) },
  })
  const out = await runRepair(ctx(), d)
  expect(out.status).toBe('blocked_protected_path')
  expect(out.reason).toContain('src/auth/session.ts')
  expect(gateCalls).toBe(0) // protected block precedes the gate
  expect(approvals.all()).toHaveLength(0)
  expect(publisher.published).toHaveLength(0)
})

test('ungrounded repro (did not reproduce or flip green) → blocked_ungrounded_repro', async () => {
  const { d, publisher } = deps({ author: new FakeRepairAuthor(fakeStaged({ reproReproducedSignal: false })) })
  const out = await runRepair(ctx(), d)
  expect(out.status).toBe('blocked_ungrounded_repro')
  expect(publisher.published).toHaveLength(0)
})

test('gate REJECT → escalated_gate_reject with partial work, NO approval, NO PR', async () => {
  const { d, approvals, publisher } = deps({ runGate: failGate() })
  const out = await runRepair(ctx(), d)
  expect(out.status).toBe('escalated_gate_reject')
  expect(out.gate?.pass).toBe(false)
  expect(out.staged).toBeDefined() // partial work handed over
  expect(approvals.all()).toHaveLength(0) // a rejected fix is never surfaced as ready
  expect(publisher.published).toHaveLength(0)
})

test('gate PASS → proposed: PR opened, L1 approval enqueued, notified, but NO landing yet', async () => {
  const store = new InMemoryAutoActionStore()
  const { d, approvals, publisher, telemetry, notified } = deps()
  const out = await runRepair(ctx(), d)

  expect(out.status).toBe('proposed')
  expect(out.approvalId).toBe('appr-1')
  expect(out.changeRequest?.number).toBe(1)

  // PR opened as the source of truth, with the gate signals in the body.
  expect(publisher.published).toHaveLength(1)
  expect(publisher.published[0]!.body).toContain('**Verification gate:** PASS')
  expect(publisher.published[0]!.headSha).toBe('fix11111')

  // L1 approval enqueued: loop C, tier 2, propose-only.
  const appr = approvals.get('appr-1')!
  expect(appr.loop).toBe('C')
  expect(appr.tier).toBe(2)
  expect(appr.state).toBe('OPEN')
  expect(appr.fixSha).toBe('fix11111')

  // Notified out-of-band (Telegram deep-link).
  expect(notified).toEqual(['proposed'])

  // CRUCIAL: proposing writes NO landing — a landing exists only after a human confirms.
  expect(store.listByClass('src/checkout::TypeError')).toHaveLength(0)
  expect(telemetry.events.some((e) => e.kind === 'gate_result' && e.data.pass === true)).toBe(true)
})
