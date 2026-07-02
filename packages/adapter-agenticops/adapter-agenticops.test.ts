import { test, expect } from 'bun:test'
import type { TelemetryEvent, WorkItem } from '@sho/contracts'
import {
  AgenticOpsTelemetry,
  AgenticOpsBacklog,
  type AgenticOpsAuditInput,
  type AgenticOpsEnqueueOptions,
} from './src/index'

// ── Fakes shaped EXACTLY like the real AgenticOps public API (telemetry.ts / backlog.ts) ──

/** Mirrors Telemetry.audit(ev: AuditInput, now = Date.now()): number (append-only, returns id). */
class FakeTelemetry {
  readonly events: { id: number; at: number; agent: string; kind: string; action: string; detail: unknown }[] = []
  private seq = 0
  audit(ev: AgenticOpsAuditInput, now = Date.now()): number {
    const id = ++this.seq
    this.events.push({ id, at: now, agent: ev.agent, kind: ev.kind, action: ev.action, detail: ev.detail ?? null })
    return id
  }
}

/** Mirrors Backlog.enqueue(agent, payload, opts): number / complete(id): void (delete). */
class FakeBacklog {
  readonly rows = new Map<number, { agent: string; payload: unknown }>()
  enqueueCalls = 0
  private seq = 0
  enqueue(agent: string, payload: unknown, _opts: AgenticOpsEnqueueOptions = {}): number {
    this.enqueueCalls++
    const id = ++this.seq
    // the real Backlog JSON round-trips the payload into SQLite — replicate that fidelity
    this.rows.set(id, { agent, payload: JSON.parse(JSON.stringify(payload ?? null)) })
    return id
  }
  complete(id: number): void {
    this.rows.delete(id)
  }
}

const ev = (kind: TelemetryEvent['kind'], extra: Partial<TelemetryEvent> = {}): TelemetryEvent => ({
  kind,
  at: '2026-07-02T10:00:00.000Z',
  classKey: 'src/checkout::T',
  incidentId: 'inc-1',
  data: { n: 1 },
  ...extra,
})

const item: WorkItem = {
  id: 'apr-1',
  kind: 'approval',
  title: 'Approve fix for src/checkout',
  classKey: 'src/checkout::T',
  tier: 2,
  payload: { fix_sha: 'f1' },
}

// ── Telemetry: every SHO kind → semantically-honest AuditKind, never one bucket ──
test('AgenticOpsTelemetry maps each event kind to the honest AuditKind + sho.* action', () => {
  const fake = new FakeTelemetry()
  const sink = new AgenticOpsTelemetry(fake)
  const expected: [TelemetryEvent['kind'], string][] = [
    ['harm', 'tool'],
    ['trust_transition', 'auth'],
    ['gate_result', 'auth'],
    ['rca_outcome', 'lifecycle'],
    ['mttr_split', 'lifecycle'],
    ['llm_cost', 'tool'],
  ]
  for (const [kind] of expected) sink.emit(ev(kind))
  expect(fake.events.map((e) => [e.action.replace('sho.', ''), e.kind])).toEqual(expected)
  expect(new Set(fake.events.map((e) => e.kind)).size).toBe(3) // uses the full real vocabulary
  for (const e of fake.events) expect(e.action.startsWith('sho.')).toBe(true)
})

test('AgenticOpsTelemetry records event time (e.at) as the audit timestamp, agent defaults to sho', () => {
  const fake = new FakeTelemetry()
  new AgenticOpsTelemetry(fake).emit(ev('harm'))
  expect(fake.events[0]!.at).toBe(Date.parse('2026-07-02T10:00:00.000Z'))
  expect(fake.events[0]!.agent).toBe('sho')
  expect(fake.events[0]!.detail).toEqual({ classKey: 'src/checkout::T', incidentId: 'inc-1', data: { n: 1 } })
})

test('AgenticOpsTelemetry keeps a stable detail shape when optional fields are absent', () => {
  const fake = new FakeTelemetry()
  new AgenticOpsTelemetry(fake, { agent: 'sho-prod' }).emit({ kind: 'llm_cost', at: '2026-07-02T10:00:00Z', data: { usd: 0.01 } })
  expect(fake.events[0]!.agent).toBe('sho-prod')
  expect(fake.events[0]!.detail).toEqual({ classKey: null, incidentId: null, data: { usd: 0.01 } })
})

test('AgenticOpsTelemetry falls back to the real API default when e.at is unparseable', () => {
  const fake = new FakeTelemetry()
  const before = Date.now()
  new AgenticOpsTelemetry(fake).emit(ev('mttr_split', { at: 'not-a-date' }))
  expect(fake.events[0]!.at).toBeGreaterThanOrEqual(before) // fake's `now = Date.now()` default kicked in
})

// ── Backlog: idempotent enqueue on item.id (no dedupe key exists in the real API) ──
test('AgenticOpsBacklog enqueues the full WorkItem as payload for the configured agent', () => {
  const fake = new FakeBacklog()
  const port = new AgenticOpsBacklog(fake)
  port.enqueue(item)
  const taskId = port.taskIdFor('apr-1')!
  expect(fake.rows.get(taskId)).toEqual({ agent: 'sho', payload: item })
})

test('AgenticOpsBacklog re-enqueueing an existing id is a no-op (adapter-side guard)', () => {
  const fake = new FakeBacklog()
  const port = new AgenticOpsBacklog(fake)
  port.enqueue(item)
  port.enqueue({ ...item, title: 'changed' }) // same id — must not create a second task
  expect(fake.enqueueCalls).toBe(1)
  expect(fake.rows.size).toBe(1)
})

test('AgenticOpsBacklog complete() calls the real deletion and retains the SHO outcome', () => {
  const fake = new FakeBacklog()
  const port = new AgenticOpsBacklog(fake, { agent: 'sho-hitl' })
  port.enqueue(item)
  const taskId = port.taskIdFor('apr-1')!
  expect(fake.rows.get(taskId)!.agent).toBe('sho-hitl')
  port.complete('apr-1', 'approved')
  expect(fake.rows.has(taskId)).toBe(false) // real Backlog.complete deletes the task
  expect(port.outcomeFor('apr-1')).toBe('approved')
  port.enqueue(item) // port contract: completed id stays a no-op
  expect(fake.enqueueCalls).toBe(1)
})

test('AgenticOpsBacklog complete() on an unknown id is a no-op', () => {
  const fake = new FakeBacklog()
  const port = new AgenticOpsBacklog(fake)
  port.complete('never-enqueued', 'resolved')
  expect(fake.rows.size).toBe(0)
  expect(port.outcomeFor('never-enqueued')).toBeUndefined()
})
