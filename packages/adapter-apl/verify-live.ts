/**
 * verify-live — proves @sho/adapter-apl against APL's REAL contract/normalize code
 * (imported from the APL clone by absolute path; both files are pure TS with no
 * server-only deps). Round-trip: SHO TelemetryEvent → AplTelemetry → APL's real
 * normalizeGenAI → validateTrace must report ZERO contract violations, and the
 * canonical operations must classify as intended.
 *
 * Run: bun packages/adapter-apl/verify-live.ts (or from this dir: bun verify-live.ts)
 */

/* eslint-disable no-console */
import {
  Apl,
  GenAI,
  AplOperation,
  MANDATORY_RESOURCE_ATTRS,
} from '/Users/duchenchuk/Documents/ClaudeCode/apl/packages/core/src/contract.ts'
import {
  normalizeGenAI,
  validateTrace,
  canonicalShape,
} from '/Users/duchenchuk/Documents/ClaudeCode/apl/packages/core/src/normalize.ts'
import type { TelemetryEvent } from '@sho/contracts'
import { APL, GEN_AI, OPERATION, AplTelemetry, type AplRawTrace } from './src/index'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// ── 1. The copied attribute names ARE the real ones ──────────────────────────
check('APL.* constants match real contract.ts Apl', (Object.keys(APL) as (keyof typeof APL)[]).every((k) => APL[k] === Apl[k]))
check('GEN_AI.* constants match real contract.ts GenAI', (Object.keys(GEN_AI) as (keyof typeof GEN_AI)[]).every((k) => GEN_AI[k] === GenAI[k]))
check(
  'OPERATION values match real AplOperation',
  OPERATION.INVOKE_AGENT === AplOperation.INVOKE_AGENT && OPERATION.CHAT === AplOperation.CHAT && OPERATION.EXECUTE_TOOL === AplOperation.EXECUTE_TOOL,
)
check(
  'mandatory Resource attrs are the two we stamp',
  MANDATORY_RESOURCE_ATTRS.length === 2 && MANDATORY_RESOURCE_ATTRS.includes(APL.TENANT_ID) && MANDATORY_RESOURCE_ATTRS.includes(APL.PRODUCT_ID),
)

// ── 2. Round-trip every SHO TelemetryEvent kind through APL's real normalize ──
const exported: AplRawTrace[] = []
const sink = new AplTelemetry({
  tenantId: 'tenant-live',
  productId: 'sho',
  agentId: 'sho-loop-a',
  agentVersion: '1.0.0',
  exporter: (traces) => {
    exported.push(...traces)
  },
})

const events: TelemetryEvent[] = [
  { kind: 'rca_outcome', at: '2026-07-02T10:00:00Z', incidentId: 'inc-1', classKey: 'checkout|nullderef', data: { label: 'confirmed_good', hypothesis: 'null deref in price calc' } },
  { kind: 'harm', at: '2026-07-02T10:01:00Z', incidentId: 'inc-2', data: { reason: 'auto-fix caused 500s' } },
  { kind: 'trust_transition', at: '2026-07-02T10:02:00Z', classKey: 'checkout|nullderef', data: { from: 'L2', to: 'L1', reason: 'recurrence' } },
  { kind: 'gate_result', at: '2026-07-02T10:03:00Z', incidentId: 'inc-3', data: { pass: false, moduleArea: 'checkout', reason: 'VACUOUS' } },
  { kind: 'llm_cost', at: '2026-07-02T10:04:00Z', incidentId: 'inc-3', data: { model: 'claude-sonnet-4-5', provider: 'anthropic', inputTokens: 900, outputTokens: 120, costUsd: 0.004 } },
  { kind: 'mttr_split', at: '2026-07-02T10:05:00Z', incidentId: 'inc-3', data: { detectMs: 30000, rcaMs: 90000, fixMs: 300000 } },
]
for (const e of events) await sink.emit(e)
check('adapter exported one trace per event', exported.length === events.length, `${exported.length}/${events.length}`)

for (let i = 0; i < exported.length; i++) {
  const kind = events[i]!.kind
  // AplRawTrace is structurally identical to APL's RawTrace — the real normalize accepts it as-is.
  const normalized = normalizeGenAI(exported[i]!)
  const errors = validateTrace(normalized)
  check(`normalize+validate accepts '${kind}' trace`, errors.length === 0, errors.join('; '))

  const root = normalized.spans[0]!
  check(`'${kind}' root classified as invoke_agent`, root.operation === AplOperation.INVOKE_AGENT)
}

// ── 3. Canonical classification of the child spans ───────────────────────────
const gateTrace = normalizeGenAI(exported[3]!)
check('gate_result child classified as execute_tool', gateTrace.spans[1]!.operation === AplOperation.EXECUTE_TOOL)
check(
  'gate trace canonical shape = tool under agent',
  JSON.stringify(canonicalShape(gateTrace)) === JSON.stringify(['execute_tool<invoke_agent', 'invoke_agent<']),
  JSON.stringify(canonicalShape(gateTrace)),
)

const costTrace = normalizeGenAI(exported[4]!)
check('llm_cost child classified as chat', costTrace.spans[1]!.operation === AplOperation.CHAT)
check('chat span kept usage attrs', costTrace.spans[1]!.attributes[GenAI.USAGE_INPUT_TOKENS] === 900 && costTrace.spans[1]!.attributes[GenAI.USAGE_OUTPUT_TOKENS] === 120)

const mttrTrace = normalizeGenAI(exported[5]!)
check('mttr_split child preserved as framework-internal (operation=null)', mttrTrace.spans[1]!.operation === null)
check('mttr_split raw span preserved verbatim', mttrTrace.spans[1]!.raw.attributes['sho.mttr.detectMs'] === 30000)

// ── 4. Per-invocation apl.* facts survive normalization ──────────────────────
const rca = normalizeGenAI(exported[0]!)
check('apl.outcome survives normalize', rca.spans[0]!.attributes[Apl.OUTCOME] === 'success')
check('apl.task_id = SHO incident id', rca.spans[0]!.attributes[Apl.TASK_ID] === 'inc-1')
const harm = normalizeGenAI(exported[1]!)
check('harm keep-hint survives normalize', harm.spans[0]!.attributes[Apl.KEEP] === true)

console.log(failures === 0 ? '\nverify-live: ALL CHECKS PASSED (adapter round-trips through APL’s real normalize/contract)' : `\nverify-live: ${failures} FAILURES`)
if (failures > 0) process.exit(1)
