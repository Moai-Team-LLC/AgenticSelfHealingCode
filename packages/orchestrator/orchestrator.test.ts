import { test, expect } from 'bun:test'
import type { GateResult, OutcomeEvent, OutcomeEventKind } from '@sho/contracts'
import {
  KillSwitch, InMemoryAutoActionStore, applyTimeWrite, appliedEvents,
  route, canTransition, statusProjection, NotifyStore, type LandingInput,
} from './src/index'

const NOW = Date.parse('2026-07-01T00:00:00.000Z')
const DAY = 86_400_000
const gate: GateResult = {
  pass: true, moduleArea: 'src/checkout', loop: 'C', tier: 2,
  signals: { mustFailOnParent: { pass: true, code: 'DISCRIMINATING' }, mutationScore: { pass: true, score: 1, threshold: 0.75 }, noWeakening: null, diffLines: 5, exceedsClassBudget: false },
  reason: 'ok',
}
const landing = (over: Partial<LandingInput> = {}): LandingInput => ({
  incident_id: 'inc1', class_key: 'src/checkout::null_deref', loop: 'C', applied_by: 'machine',
  fix_sha: 'fix1', parent_sha: 'par1', gate_result: gate, accountable_owner: '@sho-owner', module_area: 'src/checkout', applied_at: NOW_ISO(), ...over,
})
function NOW_ISO() { return new Date(NOW).toISOString() }

// ── kill switch ──
test('kill switch: engage → killed; signed release with fresh heartbeat → not killed', () => {
  const ks = new KillSwitch(NOW, 30_000, 'signed-token')
  expect(ks.isKilled(NOW)).toBe(false)
  ks.engage()
  expect(ks.isKilled(NOW)).toBe(true)
  expect(ks.release('wrong')).toBe(true) // still killed
  expect(ks.release('signed-token')).toBe(false) // released
  expect(ks.isKilled(NOW)).toBe(false)
})
test('kill switch: stale heartbeat = KILLED (fail-safe), release cannot clear staleness', () => {
  const ks = new KillSwitch(NOW, 30_000, 'tok')
  expect(ks.isKilled(NOW + 60_000)).toBe(true) // heartbeat older than TTL
  ks.release('tok')
  expect(ks.isKilled(NOW + 60_000)).toBe(true) // still stale → still killed
  ks.heartbeat(NOW + 60_000)
  expect(ks.isKilled(NOW + 60_000)).toBe(false)
})

// ── apply-time writer (coherence #3/#5) ──
test('apply-time writer is idempotent on (incident_id, fix_sha)', () => {
  const store = new InMemoryAutoActionStore()
  let links = 0
  const a = applyTimeWrite(store, landing(), () => links++)
  const b = applyTimeWrite(store, landing(), () => links++) // redelivery
  expect(a.created).toBe(true)
  expect(b.created).toBe(false)
  expect(b.action.action_id).toBe(a.action.action_id) // same row, no orphan
  expect(links).toBe(1) // linkResolution only on create (freeze-trigger safe)
})
test('writes BOTH applied_by variants — the assisted_action the ladder needs', () => {
  const store = new InMemoryAutoActionStore()
  applyTimeWrite(store, landing({ applied_by: 'machine', fix_sha: 'f1' }))
  applyTimeWrite(store, landing({ applied_by: 'human_approved', fix_sha: 'f2' }))
  const rows = store.listByClass('src/checkout::null_deref')
  expect(rows.map((r) => r.applied_by).sort()).toEqual(['human_approved', 'machine'])
  expect(appliedEvents(store, 'src/checkout::null_deref').every((e) => e.kind === 'applied')).toBe(true)
})

// ── router (coherence #7) ──
let seq = 0
const ev = (kind: OutcomeEventKind, atMs: number): OutcomeEvent => ({ actionId: `a${seq++}`, kind, at: new Date(atMs).toISOString() })
test('router: killed → L0/tier1; earned class → L2/tier2 with the L2 mutation bar', () => {
  const killed = route({ classKey: 'c', loop: 'C', owner: '@o', outcomeEvents: [], parentSHA: 'p', fixSHA: 'f' }, NOW, { killed: true })
  expect(killed.level).toBe('L0')
  expect(killed.tier).toBe(1)

  const events = [ev('applied', NOW - 60 * DAY), ...Array.from({ length: 30 }, () => ev('matured', NOW - 30 * DAY))]
  const earned = route({ classKey: 'c', loop: 'C', owner: '@o', outcomeEvents: events, parentSHA: 'p', fixSHA: 'f' }, NOW, { killed: false })
  expect(earned.level).toBe('L2')
  expect(earned.tier).toBe(2)
  expect(earned.requiredMutationScore).toBe(0.75)
  expect(earned.accountableOwner).toBe('@o') // D9 passthrough
})

// ── state machine + notify CAS ──
test('state machine: legal vs illegal transitions + status projection', () => {
  expect(canTransition('verifying', 'landed')).toBe(true)
  expect(canTransition('landed', 'outcome_watch')).toBe(true)
  expect(canTransition('ingested', 'landed')).toBe(false)
  expect(statusProjection('landed')).toBe('diagnosed')
  expect(statusProjection('outcome_watch')).toBe('resolved')
  expect(statusProjection('deduped')).toBe('open')
})
test('notify CAS: first transition delivers, second is a no-op (no double-notify)', () => {
  const n = new NotifyStore()
  expect(n.casNotified('inc1')).toBe(true)
  expect(n.casNotified('inc1')).toBe(false)
  expect(n.get('inc1')).toBe('notified')
})
