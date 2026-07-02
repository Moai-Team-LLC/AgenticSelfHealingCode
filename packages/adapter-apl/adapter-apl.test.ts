import { test, expect } from 'bun:test'
import type { TelemetryEvent } from '@sho/contracts'
import { AplTelemetry, type AplRawTrace } from './src/index'

// Offline harness: the exporter is injected and just records — no I/O, no APL dep.
function harness() {
  const exported: AplRawTrace[] = []
  const sink = new AplTelemetry({
    tenantId: 'tenant-1',
    productId: 'sho',
    agentId: 'sho-loop-a',
    agentVersion: '1.2.3',
    exporter: (traces) => {
      exported.push(...traces)
    },
  })
  return { exported, sink }
}

const ev = (kind: TelemetryEvent['kind'], data: Record<string, unknown>, extra: Partial<TelemetryEvent> = {}): TelemetryEvent => ({
  kind,
  at: '2026-07-02T00:00:00Z',
  data,
  ...extra,
})

// ── Resource identity + root span: the exact names from APL contract.ts ──

test('every trace carries Resource identity and an invoke_agent root per APL contract', async () => {
  const { exported, sink } = harness()
  await sink.emit(ev('rca_outcome', { label: 'confirmed_good' }, { incidentId: 'inc-1', classKey: 'checkout|nullderef' }))

  const trace = exported[0]!
  // MANDATORY_RESOURCE_ATTRS — literal names copied from apl contract.ts
  expect(trace.resource['apl.tenant_id']).toBe('tenant-1')
  expect(trace.resource['apl.product_id']).toBe('sho')

  const root = trace.spans[0]!
  expect(root.parentSpanId).toBeNull()
  expect(root.name).toBe('invoke_agent sho-loop-a') // operation-first span naming (contract.ts §1)
  // MANDATORY_SPAN_ATTRS[invoke_agent] — literal names
  expect(root.attributes['gen_ai.operation.name']).toBe('invoke_agent')
  expect(root.attributes['apl.agent_id']).toBe('sho-loop-a')
  expect(root.attributes['apl.agent_version']).toBe('1.2.3')
  // per-invocation facts: SHO's incident is the task
  expect(root.attributes['apl.task_id']).toBe('inc-1')
  expect(root.attributes['sho.class_key']).toBe('checkout|nullderef')
})

// ── rca_outcome → APL eval/outcome semantics ──

test('rca_outcome maps SHO outcome labels onto APL Outcome vocabulary', async () => {
  const { exported, sink } = harness()
  await sink.emit(ev('rca_outcome', { label: 'confirmed_good' }))
  await sink.emit(ev('rca_outcome', { label: 'recurred' }))
  await sink.emit(ev('rca_outcome', { label: 'proposed' }))
  await sink.emit(ev('rca_outcome', { label: 'applied' }))
  await sink.emit(ev('rca_outcome', { label: 'provisional_human_confirmed' }))

  const outcomes = exported.map((t) => t.spans[0]!.attributes['apl.outcome'])
  expect(outcomes).toEqual(['success', 'fail', 'escalated', 'unknown', 'success'])

  // fail/escalated stamp the tail-sampling keep-hint, exactly like APL's own SDK
  expect(exported[1]!.spans[0]!.attributes['apl.keep']).toBe(true)
  expect(exported[2]!.spans[0]!.attributes['apl.keep']).toBe(true)
  expect(exported[0]!.spans[0]!.attributes['apl.keep']).toBeUndefined()

  // human-confirmed label is a human judgment → apl.human_feedback in sdk.ts format
  expect(exported[4]!.spans[0]!.attributes['apl.human_feedback']).toBe('thumbs:up')
})

test('rca_outcome carries the hypothesis as apl.decision_reason', async () => {
  const { exported, sink } = harness()
  await sink.emit(ev('rca_outcome', { label: 'reverted', hypothesis: 'null deref in price calc' }))
  expect(exported[0]!.spans[0]!.attributes['apl.decision_reason']).toBe('null deref in price calc')
})

// ── harm ──

test('harm → outcome=fail + keep=true + decision_reason', async () => {
  const { exported, sink } = harness()
  await sink.emit(ev('harm', { reason: 'auto-fix caused checkout 500s' }, { incidentId: 'inc-9' }))
  const attrs = exported[0]!.spans[0]!.attributes
  expect(attrs['apl.outcome']).toBe('fail')
  expect(attrs['apl.keep']).toBe(true)
  expect(attrs['apl.decision_reason']).toBe('harm: auto-fix caused checkout 500s')
})

// ── trust_transition ──

test('trust demotion → escalated (+keep); promotion → success; detail in decision_reason', async () => {
  const { exported, sink } = harness()
  await sink.emit(ev('trust_transition', { from: 'L2', to: 'L1', reason: 'recurrence within W_recur' }))
  await sink.emit(ev('trust_transition', { from: 'L1', to: 'L2' }))
  await sink.emit(ev('trust_transition', {}))

  const demo = exported[0]!.spans[0]!.attributes
  expect(demo['apl.outcome']).toBe('escalated')
  expect(demo['apl.keep']).toBe(true)
  expect(demo['apl.decision_reason']).toBe('trust_transition L2->L1: recurrence within W_recur')

  const promo = exported[1]!.spans[0]!.attributes
  expect(promo['apl.outcome']).toBe('success')
  expect(promo['apl.keep']).toBeUndefined()
  expect(promo['apl.decision_reason']).toBe('trust_transition L1->L2')

  expect(exported[2]!.spans[0]!.attributes['apl.outcome']).toBe('unknown')
})

// ── gate_result → execute_tool child span ──

test('gate_result → child execute_tool span named per contract, gate detail under sho.gate.*', async () => {
  const { exported, sink } = harness()
  await sink.emit(ev('gate_result', { pass: false, moduleArea: 'checkout', reason: 'VACUOUS test' }))

  const [root, gate] = exported[0]!.spans
  expect(gate!.parentSpanId).toBe(root!.spanId)
  expect(gate!.name).toBe('execute_tool verification_gate')
  // MANDATORY_SPAN_ATTRS[execute_tool] — literal names
  expect(gate!.attributes['gen_ai.operation.name']).toBe('execute_tool')
  expect(gate!.attributes['gen_ai.tool.name']).toBe('verification_gate')
  expect(gate!.attributes['sho.gate.pass']).toBe(false)
  expect(gate!.attributes['sho.gate.module_area']).toBe('checkout')
  expect(gate!.attributes['sho.gate.reason']).toBe('VACUOUS test')
  expect(root!.attributes['apl.keep']).toBe(true) // failed gate = keep this trace
})

// ── llm_cost → chat child span with GenAI usage attributes ──

test('llm_cost → chat span with gen_ai.request.model / usage token attributes', async () => {
  const { exported, sink } = harness()
  await sink.emit(ev('llm_cost', { model: 'claude-sonnet-4-5', provider: 'anthropic', inputTokens: 1200, outputTokens: 340, costUsd: 0.0087 }))

  const chat = exported[0]!.spans[1]!
  expect(chat.name).toBe('chat claude-sonnet-4-5')
  // MANDATORY_SPAN_ATTRS[chat] + usage — literal names from contract.ts GenAI
  expect(chat.attributes['gen_ai.operation.name']).toBe('chat')
  expect(chat.attributes['gen_ai.request.model']).toBe('claude-sonnet-4-5')
  expect(chat.attributes['gen_ai.provider.name']).toBe('anthropic')
  expect(chat.attributes['gen_ai.usage.input_tokens']).toBe(1200)
  expect(chat.attributes['gen_ai.usage.output_tokens']).toBe(340)
  expect(chat.attributes['sho.cost_usd']).toBe(0.0087)
})

test('llm_cost without a model still satisfies the chat contract (model=unknown)', async () => {
  const { exported, sink } = harness()
  await sink.emit(ev('llm_cost', { inputTokens: 10 }))
  const chat = exported[0]!.spans[1]!
  expect(chat.attributes['gen_ai.request.model']).toBe('unknown')
  expect(chat.name).toBe('chat unknown')
})

// ── mttr_split → framework-internal span (no canonical operation) ──

test('mttr_split → internal child span, numeric splits under sho.mttr.*', async () => {
  const { exported, sink } = harness()
  await sink.emit(ev('mttr_split', { detectMs: 30_000, rcaMs: 120_000, fixMs: 600_000, note: 'not-a-number' }))

  const split = exported[0]!.spans[1]!
  expect(split.attributes['gen_ai.operation.name']).toBeUndefined() // deliberately non-canonical
  expect(split.attributes['sho.mttr.detectMs']).toBe(30_000)
  expect(split.attributes['sho.mttr.rcaMs']).toBe(120_000)
  expect(split.attributes['sho.mttr.fixMs']).toBe(600_000)
  expect(split.attributes['sho.mttr.note']).toBeUndefined() // non-numeric data is not a timing split
})

// ── plumbing ──

test('span ids are unique across emits; task_id falls back classKey then kind@at', async () => {
  const { exported, sink } = harness()
  await sink.emit(ev('harm', {}, { classKey: 'ck-1' }))
  await sink.emit(ev('harm', {}))
  const ids = exported.flatMap((t) => t.spans.map((s) => s.spanId))
  expect(new Set(ids).size).toBe(ids.length)
  expect(exported[0]!.spans[0]!.attributes['apl.task_id']).toBe('ck-1')
  expect(exported[1]!.spans[0]!.attributes['apl.task_id']).toBe('harm@2026-07-02T00:00:00Z')
})

test('emit returns the exporter promise (callers may await delivery)', async () => {
  let delivered = false
  const sink = new AplTelemetry({
    tenantId: 't',
    productId: 'p',
    exporter: async () => {
      await Promise.resolve()
      delivered = true
    },
  })
  await sink.emit(ev('harm', {}))
  expect(delivered).toBe(true)
})
