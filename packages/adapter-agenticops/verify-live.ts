/**
 * Live verification against the REAL AgenticOps classes (pure TS lib, imported from the clone's
 * absolute path). Proves the duck-typed adapter surfaces are assignable from the real classes and
 * that the mapping behaves end-to-end on the real SQLite-backed implementations (':memory:').
 *   bun run verify-live.ts
 */

import { Telemetry, Backlog } from '/Users/duchenchuk/Documents/ClaudeCode/AgenticOps/src/index.ts'
import type { TelemetryEvent, WorkItem } from '@sho/contracts'
import { AgenticOpsTelemetry, AgenticOpsBacklog } from './src/index'

let ok = 0, fail = 0
const check = (n: string, c: boolean, e = '') => { c ? ok++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${n}${e ? `  — ${e}` : ''}`) }

// ── 1. Telemetry: real class satisfies the duck type; kinds land honestly in the real audit ──
const tel = new Telemetry(':memory:')
const sink = new AgenticOpsTelemetry(tel) // ← REAL Telemetry instance, no cast
const kinds: TelemetryEvent['kind'][] = ['harm', 'trust_transition', 'gate_result', 'rca_outcome', 'mttr_split', 'llm_cost']
for (const kind of kinds) {
  sink.emit({ kind, at: '2026-07-02T10:00:00.000Z', classKey: 'src/checkout::T', incidentId: 'inc-1', data: { kind } })
}
const recent = tel.recent({ agent: 'sho' }) // newest first
check('telemetry: all 6 SHO kinds recorded in the real audit', recent.length === 6, `got ${recent.length}`)
const byAction = new Map(recent.map((e) => [e.action, e]))
check('telemetry: harm → tool', byAction.get('sho.harm')?.kind === 'tool')
check('telemetry: trust_transition → auth', byAction.get('sho.trust_transition')?.kind === 'auth')
check('telemetry: gate_result → auth', byAction.get('sho.gate_result')?.kind === 'auth')
check('telemetry: rca_outcome → lifecycle', byAction.get('sho.rca_outcome')?.kind === 'lifecycle')
check('telemetry: mttr_split → lifecycle', byAction.get('sho.mttr_split')?.kind === 'lifecycle')
check('telemetry: llm_cost → tool', byAction.get('sho.llm_cost')?.kind === 'tool')
check('telemetry: event time (not write time) persisted as at', recent.every((e) => e.at === Date.parse('2026-07-02T10:00:00.000Z')))
const harm = byAction.get('sho.harm')!
check('telemetry: detail round-trips through the real SQLite store',
  JSON.stringify(harm.detail) === JSON.stringify({ classKey: 'src/checkout::T', incidentId: 'inc-1', data: { kind: 'harm' } }))
tel.close()

// ── 2. Backlog: idempotent enqueue + real claim/complete lifecycle ──
const bl = new Backlog(':memory:')
const port = new AgenticOpsBacklog(bl) // ← REAL Backlog instance, no cast
const item: WorkItem = { id: 'apr-1', kind: 'approval', title: 'Approve fix', classKey: 'src/checkout::T', tier: 2, payload: { fix_sha: 'f1' } }
port.enqueue(item)
check('backlog: enqueue lands one durable task', bl.stats().pending === 1)
port.enqueue({ ...item, title: 'changed' }) // same id
check('backlog: re-enqueue of the same WorkItem.id is a no-op', bl.stats().pending === 1)
const claimed = bl.claim({ now: Date.now() })
check('backlog: claimed task targets the configured agent', claimed?.agent === 'sho')
check('backlog: WorkItem rides intact as the payload (id preserved for durable dedupe)',
  JSON.stringify(claimed?.payload) === JSON.stringify(item))
check('backlog: adapter maps SHO id → real task id', port.taskIdFor('apr-1') === claimed?.id)
port.complete('apr-1', 'approved')
const s = bl.stats()
check('backlog: complete() removes the task from the real queue', s.pending === 0 && s.leased === 0 && s.failed === 0)
check('backlog: SHO outcome retained adapter-side', port.outcomeFor('apr-1') === 'approved')
port.enqueue(item)
check('backlog: completed id stays a no-op (port contract)', bl.stats().pending === 0)
bl.close()

console.log(`\n${ok} pass, ${fail} fail (against REAL AgenticOps classes)`)
process.exit(fail === 0 ? 0 : 1)
