/**
 * Live verification of the DURABLE repair proposal index (orch.repair_proposal, migration 0008). The property
 * that matters: a proposal recorded at propose time SURVIVES a restart, so the merge webhook can still confirm
 * it after a crash (an in-memory index would drop it, and the fix would deploy with no landing). Runs PgRepairIndex.
 *   DATABASE_URL=… bun run packages/app/verify-repair-pg.ts
 */

import { SQL } from 'bun'
import type { Query } from '@sho/orchestrator'
import type { GateResult } from '@sho/contracts'
import { PgRepairIndex } from './src/repairindex'

const url = process.env.DATABASE_URL
if (!url) { console.error('set DATABASE_URL'); process.exit(2) }
const sql = new SQL(url)
const query: Query = async (t, p) => (await sql.unsafe(t, (p ?? []) as never[])) as Record<string, unknown>[]
let ok = 0, fail = 0
const check = (n: string, c: boolean, e = '') => { c ? ok++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${n}${e ? `  — ${e}` : ''}`) }
const gate: GateResult = { pass: true, moduleArea: 'src/checkout', signals: { mustFailOnParent: { pass: true, code: 'DISCRIMINATING' }, mutationScore: { pass: true, score: 0.82, threshold: 0.6 }, noWeakening: { pass: true }, diffLines: 6, exceedsClassBudget: false }, reason: 'PASS' }

try {
  await query(`TRUNCATE orch.repair_proposal`)
  const rec = { approvalId: 'appr-idx-1', incidentId: 'inc-idx-1', classKey: 'src/checkout::E', moduleArea: 'src/checkout', parentSha: 'p0', fixSha: 'f1', prNumber: 101, prUrl: 'https://gh/pr/101', accountableOwner: 'team-checkout', gateResult: gate }

  const idx = new PgRepairIndex(query)
  await idx.record(rec)
  check('record: found by approvalId', (await idx.byApprovalId('appr-idx-1'))?.prNumber === 101)
  check('record: found by prNumber (the merge-webhook lookup)', (await idx.byPrNumber(101))?.approvalId === 'appr-idx-1')

  // ── restart: a fresh instance reads the row (the whole point). ──
  const restart = new PgRepairIndex(query)
  const got = await restart.byPrNumber(101)
  check('proposal SURVIVES RESTART (fresh instance finds it by PR number)', got?.approvalId === 'appr-idx-1', `status=${got?.status}`)
  check('gate_result round-trips through jsonb (.pass usable)', got?.gateResult?.pass === true)
  check('starts in status "proposed"', got?.status === 'proposed')

  await restart.setStatus('appr-idx-1', 'confirmed')
  check('setStatus persists', (await new PgRepairIndex(query).byApprovalId('appr-idx-1'))?.status === 'confirmed')

  // idempotent record (a redelivered propose is a no-op, not a duplicate)
  await idx.record({ ...rec, prUrl: 'https://gh/pr/999' })
  check('record is idempotent on approval_id (no duplicate row)', (await idx.list()).length === 1)

  console.log(`\n${fail === 0 ? '✅' : '❌'} durable repair index: ${ok} checks passed, ${fail} failed`)
} finally {
  await sql.end()
}
process.exit(fail > 0 ? 1 : 0)
