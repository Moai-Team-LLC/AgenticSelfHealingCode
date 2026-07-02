import { test, expect } from 'bun:test'
import { KillSwitch } from '@sho/orchestrator'
import {
  // business-hours gate
  gateAutoApply, isBusinessHours, isStaffed, hm, type BusinessHoursConfig,
  // ladder
  ApprovalQueue, DEFAULT_LADDER, isCrosswalkLegal, isTier4PlanShape, type EnqueueInput,
  // verdict
  resolveVerdict, accountableOwner,
  // notifier
  FakeNotifier, renderApproval,
  // kill release
  KillReleaseGate, canonical, type KillReleaseDeps, type KillReleaseRequest,
} from './src/index'

const MIN = 60_000

// A single-team config: staffed Mon–Fri 09:00–19:00 local, tz = UTC+3 (Europe/Nicosia summer).
const cfg: BusinessHoursConfig = {
  defaultPolicy: 'downgrade',
  teams: {
    checkout: {
      team: 'checkout',
      tzOffsetMin: 180,
      staffed: [{ days: [1, 2, 3, 4, 5], startMin: hm(9), endMin: hm(19) }],
      holidays: ['2026-07-04'],
    },
    platform: {
      team: 'platform',
      tzOffsetMin: -240,
      staffed: [{ days: [1, 2, 3, 4, 5], startMin: hm(8), endMin: hm(18) }],
      holidays: [],
    },
  },
}

// Wed 2026-07-01 12:00 LOCAL for checkout (UTC+3) → 09:00Z. In-hours.
const INHOURS = Date.parse('2026-07-01T09:00:00.000Z')
// Wed 2026-07-01 03:00 LOCAL for checkout → 00:00Z. Off-hours (before 09:00 local).
const OFFHOURS = Date.parse('2026-07-01T00:00:00.000Z')

// ── §2 BUSINESS-HOURS GATE (attack #6 closure) ──────────────────────────────
test('off-hours L2 → downgrade-to-PR (unconditional; no earned-off-hours path)', () => {
  expect(gateAutoApply('L2', OFFHOURS, cfg, ['checkout'])).toBe('downgrade-to-PR')
  expect(gateAutoApply('L3', OFFHOURS, cfg, ['checkout'])).toBe('downgrade-to-PR')
})
test('in-hours L2 → auto-apply', () => {
  expect(isStaffed(cfg.teams.checkout!, INHOURS)).toBe(true)
  expect(gateAutoApply('L2', INHOURS, cfg, ['checkout'])).toBe('auto-apply')
  expect(gateAutoApply('L3', INHOURS, cfg, ['checkout'])).toBe('auto-apply')
})
test('L0/L1 are not auto-apply — gate passes them through untouched (never routed as auto-apply)', () => {
  expect(gateAutoApply('L1', OFFHOURS, cfg, ['checkout'])).toBe('auto-apply')
  expect(gateAutoApply('L0', OFFHOURS, cfg, ['checkout'])).toBe('auto-apply')
})
test('holiday is NEVER staffed even during the window', () => {
  const july4Noon = Date.parse('2026-07-04T09:00:00.000Z') // 12:00 local checkout, but a holiday
  expect(isStaffed(cfg.teams.checkout!, july4Noon)).toBe(false)
  expect(gateAutoApply('L2', july4Noon, cfg, ['checkout'])).toBe('downgrade-to-PR')
})
test('multi-area requires ALL teams staffed (min-across-areas safe floor)', () => {
  // At 09:00Z: checkout=12:00 local (staffed); platform=05:00 local (NOT staffed) → overall unstaffed.
  expect(isStaffed(cfg.teams.platform!, INHOURS)).toBe(false)
  expect(isBusinessHours(INHOURS, cfg, ['checkout', 'platform'])).toBe(false)
  expect(gateAutoApply('L2', INHOURS, cfg, ['checkout', 'platform'])).toBe('downgrade-to-PR')
})
test('empty / unknown team set is treated as unstaffed (safe floor)', () => {
  expect(isBusinessHours(INHOURS, cfg, [])).toBe(false)
  expect(gateAutoApply('L2', INHOURS, cfg, ['ghost-team'])).toBe('downgrade-to-PR')
})

// ── §3 THE LADDER ───────────────────────────────────────────────────────────
const NOW = Date.parse('2026-07-01T09:00:00.000Z')
const enq = (over: Partial<EnqueueInput> = {}): EnqueueInput => ({
  id: over.id ?? 'req1',
  incidentId: 'inc1',
  classKey: 'src/checkout::assertion_heal',
  loop: 'C',
  tier: 3,
  requestedLevel: 2,
  whyTraceId: 'rca-uuid',
  team: 'checkout',
  primaryApprover: '@primary',
  secondaryApprover: '@secondary',
  ...over,
})

test('Tier 4 timeout → AUTO-REJECT (must never pass by default) + notify', () => {
  const q = new ApprovalQueue()
  q.enqueue(enq({ id: 'r4', tier: 4, loop: 'C', requestedLevel: 3, fixSha: null, parentSha: null }), NOW)
  // just before timeout: nothing fires
  expect(q.tick(NOW + DEFAULT_LADDER.tier4.primaryTimeoutMin * MIN - 1)).toEqual([])
  const events = q.tick(NOW + DEFAULT_LADDER.tier4.primaryTimeoutMin * MIN)
  expect(events).toEqual([{ kind: 'auto_reject', requestId: 'r4', tier: 4, atMs: NOW + 15 * MIN, notify: true }])
  expect(q.get('r4')!.state).toBe('REJECTED')
  expect(q.get('r4')!.verdictBy).toBe(null) // auto, not a human
})
test('Tier 3 timeout → SECONDARY approver (never auto-approve/reject), then page bridge', () => {
  const q = new ApprovalQueue()
  q.enqueue(enq({ id: 'r3', tier: 3 }), NOW)
  const t1 = NOW + DEFAULT_LADDER.tier3.primaryTimeoutMin * MIN
  const e1 = q.tick(t1)
  expect(e1).toEqual([{ kind: 'escalate_to_secondary', requestId: 'r3', tier: 3, atMs: t1, to: '@secondary' }])
  expect(q.get('r3')!.state).toBe('ESCALATED')
  expect(q.get('r3')!.currentApprover).toBe('@secondary')
  // second timeout → page on-call bridge, STAYS escalated, never auto-anything
  const t2 = t1 + DEFAULT_LADDER.tier3.secondaryTimeoutMin * MIN
  const e2 = q.tick(t2)
  expect(e2).toEqual([{ kind: 'page_oncall_bridge', requestId: 'r3', tier: 3, atMs: t2 }])
  expect(q.get('r3')!.state).toBe('ESCALATED')
})
test('Tier 2 ladder never auto-approves/rejects — escalate then remind (stale PR is harmless)', () => {
  const q = new ApprovalQueue()
  q.enqueue(enq({ id: 'r2', tier: 2, loop: 'B' }), NOW)
  const t1 = NOW + DEFAULT_LADDER.tier2.primaryTimeoutMin * MIN
  expect(q.tick(t1)[0]!.kind).toBe('escalate_to_secondary')
  const t2 = t1 + DEFAULT_LADDER.tier2.secondaryTimeoutMin * MIN
  expect(q.tick(t2)[0]!.kind).toBe('remind')
  expect(q.get('r2')!.state).toBe('ESCALATED') // still open, waiting on a human
})
test('ladder tick is deterministic + idempotent-once (a fired timer is disarmed)', () => {
  const q = new ApprovalQueue()
  q.enqueue(enq({ id: 'r4', tier: 4, loop: 'C', requestedLevel: 3 }), NOW)
  const at = NOW + 15 * MIN
  expect(q.tick(at).length).toBe(1)
  expect(q.tick(at)).toEqual([]) // terminal → no re-fire
})
test('crosswalk invariant: Loop B can never enqueue Tier 3/4', () => {
  const q = new ApprovalQueue()
  expect(isCrosswalkLegal(2, 'B')).toBe(true)
  expect(isCrosswalkLegal(3, 'B')).toBe(false)
  expect(() => q.enqueue(enq({ id: 'bad', tier: 3, loop: 'B' }), NOW)).toThrow(/crosswalk-illegal/)
})
test('Tier-4 row is a plan-approval with no authored diff', () => {
  const q = new ApprovalQueue()
  expect(isTier4PlanShape({ tier: 4, fixSha: null, parentSha: null })).toBe(true)
  expect(isTier4PlanShape({ tier: 4, fixSha: 'f', parentSha: null })).toBe(false)
  expect(() => q.enqueue(enq({ id: 'bad4', tier: 4, loop: 'C', fixSha: 'f', parentSha: 'p' }), NOW)).toThrow(/plan-approval/)
})
test('supersede cancels an OPEN request (request cancellation, not the outcome label)', () => {
  const q = new ApprovalQueue()
  q.enqueue(enq({ id: 'rs' }), NOW)
  expect(q.supersede('rs', NOW).state).toBe('SUPERSEDED')
  expect(q.tick(NOW + 999 * MIN)).toEqual([]) // superseded rows never escalate
})

// ── §4.2 BUTTON → VERDICT ───────────────────────────────────────────────────
test('approve (Loop A hand-off) → provisional_human_confirmed (NOT confirmed_good) + owner unchanged', () => {
  const v = resolveVerdict({
    incidentId: 'inc1', whyTraceId: 'rca', surface: 'loopA_handoff', button: 'approve', verdictBy: '@alice', atMs: NOW,
  })
  expect(v.emitLabel).toBe('provisional_human_confirmed')
  expect(v.triggersApplyTimeWrite).toBe(false)
  // owner of record stays trust_class.owner regardless of who tapped (D9)
  expect(accountableOwner('@class-owner', '@alice')).toBe('@class-owner')
})
test('reject (Loop A) → wrong_rca; reject (Loop B/C) feeds contraction breaker only', () => {
  const a = resolveVerdict({ incidentId: 'i', whyTraceId: 't', surface: 'loopA_handoff', button: 'reject', verdictBy: '@a', atMs: NOW })
  expect(a.emitLabel).toBe('wrong_rca')
  const bc = resolveVerdict({ incidentId: 'i', whyTraceId: 't', surface: 'loopBC_approval', button: 'reject', verdictBy: '@a', atMs: NOW })
  expect(bc.emitLabel).toBe(null)
  expect(bc.feedsContractionBreaker).toBe(true)
  expect(bc.triggersApplyTimeWrite).toBe(false)
})
test('approve (Loop B/C) → no positive label; triggers apply-time write; outcome stays pending', () => {
  const v = resolveVerdict({ incidentId: 'i', whyTraceId: 't', surface: 'loopBC_approval', button: 'approve', verdictBy: '@a', atMs: NOW })
  expect(v.emitLabel).toBe(null) // never confirmed_good here
  expect(v.triggersApplyTimeWrite).toBe(true)
})
test('Loop A hand-off has no Edit path', () => {
  expect(() =>
    resolveVerdict({ incidentId: 'i', whyTraceId: 't', surface: 'loopA_handoff', button: 'edit', verdictBy: '@a', atMs: NOW }),
  ).toThrow(/no Edit/)
})
test('queue approve records verdict_by descriptively but never as owner', () => {
  const q = new ApprovalQueue()
  q.enqueue(enq({ id: 'ra' }), NOW)
  const row = q.approve('ra', '@editor', NOW + MIN, 'edited-sha')
  expect(row.state).toBe('APPROVED')
  expect(row.verdictBy).toBe('@editor') // descriptive
  expect(row.fixSha).toBe('edited-sha') // edited diff becomes the change of record
  expect(accountableOwner('@class-owner', row.verdictBy!)).toBe('@class-owner') // owner unchanged
})

// ── §4 NOTIFIER (fake default) ──────────────────────────────────────────────
test('fake notifier records sends and edits-in-place (reminders never spam new messages)', () => {
  const n = new FakeNotifier()
  const q = new ApprovalQueue()
  const r = q.enqueue(enq({ id: 'rn' }), NOW)
  const view = renderApproval(r, { offHours: true })
  const ref = n.send({ chat: view.chat, text: view.text, buttons: view.buttons }, NOW)
  expect(n.sentCount()).toBe(1)
  expect(n.get(ref)!.buttons).toEqual(['approve', 'edit', 'reject'])
  expect(n.get(ref)!.text).toContain('off-hours: PR')
  // reminder edits the SAME ref
  n.send({ ref, chat: view.chat, text: view.text + '\nwaiting 5m', buttons: view.buttons }, NOW + 5 * MIN)
  expect(n.sentCount()).toBe(1) // still one send
  expect(n.editCount(ref)).toBe(1)
})
test('tier-4 render shows only approve/reject (no edit — plan approval)', () => {
  const q = new ApprovalQueue()
  const r = q.enqueue(enq({ id: 'r4v', tier: 4, loop: 'C', requestedLevel: 3 }), NOW)
  expect(renderApproval(r).buttons).toEqual(['approve', 'reject'])
})

// ── §6 KILL-SWITCH RELEASE ──────────────────────────────────────────────────
const goodDeps = (over: Partial<KillReleaseDeps> = {}): { deps: KillReleaseDeps; audits: any[] } => {
  const audits: any[] = []
  const deps: KillReleaseDeps = {
    isOnCall: (by) => by === '@oncall',
    verifyMfa: (_by, a) => a === 'valid-mfa',
    verifySignature: (sig, _msg, _by) => sig === 'good-sig',
    releaseToken: () => 'signed-token',
    audit: (e) => audits.push(e),
    ...over,
  }
  return { deps, audits }
}
const req = (over: Partial<KillReleaseRequest> = {}): KillReleaseRequest => ({
  action: 'release', by: '@oncall', mfaAssertion: 'valid-mfa', reason: 'incident over', signature: 'good-sig', nonce: 'n1', ...over,
})

test('release ONLY with the full signed on-call chain; then KillSwitch clears', () => {
  const ks = new KillSwitch(NOW, 30_000, 'signed-token')
  ks.engage()
  ks.heartbeat(NOW) // keep heartbeat fresh so only the explicit engage holds the kill
  expect(ks.isKilled(NOW)).toBe(true)
  const { deps, audits } = goodDeps()
  const gate = new KillReleaseGate(deps)
  const res = gate.requestRelease(req(), ks, NOW, NOW)
  expect(res).toEqual({ released: true, reason: 'ok' })
  expect(ks.isKilled(NOW)).toBe(false)
  expect(audits.some((a) => a.kind === 'kill_switch_release')).toBe(true)
})
test('release refused at every broken auth step — and NEVER calls KillSwitch.release', () => {
  const mk = () => { const ks = new KillSwitch(NOW, 30_000, 'signed-token'); ks.engage(); ks.heartbeat(NOW); return ks }
  const cases: [Partial<KillReleaseDeps>, Partial<KillReleaseRequest>, string][] = [
    [{ isOnCall: () => false }, {}, 'not_on_call'],
    [{ verifyMfa: () => false }, {}, 'mfa_failed'],
    [{ verifySignature: () => false }, {}, 'bad_signature'],
  ]
  for (const [depOver, reqOver, reason] of cases) {
    const ks = mk()
    const { deps } = goodDeps(depOver)
    const res = new KillReleaseGate(deps).requestRelease(req(reqOver), ks, NOW, NOW)
    expect(res.released).toBe(false)
    expect(res.reason).toBe(reason as any)
    expect(ks.isKilled(NOW)).toBe(true) // still frozen — release was never applied
  }
})
test('nonce is single-use — a replay is refused (even with an otherwise-valid chain)', () => {
  const ks1 = new KillSwitch(NOW, 30_000, 'signed-token'); ks1.engage(); ks1.heartbeat(NOW)
  const { deps } = goodDeps()
  const gate = new KillReleaseGate(deps)
  expect(gate.requestRelease(req({ nonce: 'once' }), ks1, NOW, NOW).released).toBe(true)
  const ks2 = new KillSwitch(NOW, 30_000, 'signed-token'); ks2.engage(); ks2.heartbeat(NOW)
  const replay = gate.requestRelease(req({ nonce: 'once' }), ks2, NOW, NOW)
  expect(replay).toEqual({ released: false, reason: 'nonce_replayed' })
  expect(ks2.isKilled(NOW)).toBe(true)
})
test('signature binds killed_at — canonical message changes across freezes', () => {
  expect(canonical('release', '@oncall', 'n1', 100)).not.toBe(canonical('release', '@oncall', 'n1', 200))
})
test('auth passes but stale heartbeat keeps the freeze → still_killed (fail-safe, not released)', () => {
  const ks = new KillSwitch(NOW, 30_000, 'signed-token')
  ks.engage()
  // do NOT refresh heartbeat; evaluate far in the future so heartbeat is stale
  const future = NOW + 60_000
  const { deps } = goodDeps()
  const res = new KillReleaseGate(deps).requestRelease(req(), ks, future, NOW)
  expect(res).toEqual({ released: false, reason: 'still_killed' })
  expect(ks.isKilled(future)).toBe(true) // fail-safe: a DoS/staleness can only KEEP the freeze
})
