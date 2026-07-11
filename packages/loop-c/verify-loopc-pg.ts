/**
 * Live verification of the HUMAN-CONFIRMED repair landing against real Postgres. Proves the property that
 * matters for the promotion ladder (D6): a human_approved loop-C landing is DURABLE — it survives a process
 * restart and is idempotent across both confirm channels (PR merge + Telegram), exactly like the rest of the
 * orchestrator state. Runs the real propose path (runRepair on fakes) then confirmRepair against PgAutoActionStore.
 *   DATABASE_URL=… bun run packages/loop-c/verify-loopc-pg.ts
 */

import { SQL } from 'bun'
import type { WhyTrace } from '@sho/contracts'
import { ApprovalQueue } from '@sho/hitl'
import { PgAutoActionStore, type Query } from '@sho/orchestrator'
import { runRepair, confirmRepair, FakeRepairAuthor, RecordingPublisher, passGate, fakeStaged, type RepairContext } from './src/index'

const url = process.env.DATABASE_URL
if (!url) { console.error('set DATABASE_URL'); process.exit(2) }
const sql = new SQL(url)
const query: Query = async (t, p) => (await sql.unsafe(t, (p ?? []) as never[])) as Record<string, unknown>[]
let ok = 0, fail = 0
const check = (n: string, c: boolean, e = '') => { c ? ok++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${n}${e ? `  — ${e}` : ''}`) }
const now = Date.now()

const incidentId = crypto.randomUUID() // orch.auto_action.incident_id is a UUID column
const whyTrace: WhyTrace = {
  incidentId, hypothesis: 'null cart after checkout deploy', alternatives: [],
  confidence: { reproduced: true, explainsAllOccurrences: true, affectedPathInDeployDiff: true, stepVsSlopeConsistent: true },
  correlationState: 'deploy_linked', affectedComponents: ['src/checkout/price.ts'], fixClass: 'code',
  recommendedAction: 'guard null cart', suspiciousContentFlag: false, similarIncidents: [],
}
const ctx: RepairContext = {
  incidentId, classKey: 'src/checkout::TypeError', moduleArea: 'src/checkout', team: 'checkout',
  primaryApprover: 'p', secondaryApprover: 's', whyTrace, loopADecision: 'CONFIRMED',
  autonomy: { level: 'L1', tier: 2, requiredMutationScore: 0.6, accountableOwner: 'team-checkout' },
}

try {
  await query(`TRUNCATE orch.auto_action CASCADE`)

  // ── 1. PROPOSE — the real Loop C path enqueues an L1 approval + a PR; writes NO landing yet. ──
  const approvals = new ApprovalQueue()
  const publisher = new RecordingPublisher()
  const outcome = await runRepair(ctx, {
    author: new FakeRepairAuthor(fakeStaged()), runGate: passGate(), publisher, approvals, nowMs: now,
    newApprovalId: () => 'appr-pg-1',
  })
  check('propose: gate passed → status "proposed"', outcome.status === 'proposed', outcome.reason)
  const pgStore0 = new PgAutoActionStore(query)
  check('propose: NO landing written before a human confirms', (await pgStore0.listByClass(ctx.classKey)).length === 0)

  // ── 2. CONFIRM (channel 1: GitHub PR merge) → durable human_approved landing in Postgres. ──
  const pgStore = new PgAutoActionStore(query)
  const merged = await confirmRepair(
    { approvalId: 'appr-pg-1', verdictBy: 'github:alice', parentSha: 'parent00', moduleArea: ctx.moduleArea, classKey: ctx.classKey, accountableOwner: 'team-checkout', gateResult: outcome.gate!, mergedFixSha: 'mergesha1' },
    { approvals, store: pgStore, nowMs: now },
  )
  check('confirm: landing created (human_approved, loop C)', merged.created && merged.action.applied_by === 'human_approved' && merged.action.loop === 'C', `fix_sha=${merged.action.fix_sha}`)
  check('confirm: accountable_owner = trust_class.owner (D9), not the merger', merged.action.accountable_owner === 'team-checkout')
  check('confirm: gate_result round-trips through jsonb', merged.action.gate_result?.pass === true)

  // ── 3. SURVIVES RESTART — a fresh store instance (= a new process) reads the row. ──
  const restart = new PgAutoActionStore(query)
  const got = await restart.getByIncidentFix(incidentId, 'mergesha1')
  check('landing SURVIVES RESTART (fresh instance reads it)', got?.action_id === merged.action.action_id, `applied_by=${got?.applied_by}`)
  check('landing is the only row for the class', (await restart.listByClass(ctx.classKey)).length === 1)

  // ── 4. BOTH CHANNELS idempotent — a Telegram approve after the merge is a no-op, never a double landing. ──
  const tapped = await confirmRepair(
    { approvalId: 'appr-pg-1', verdictBy: 'oncall_jane', parentSha: 'parent00', moduleArea: ctx.moduleArea, classKey: ctx.classKey, accountableOwner: 'team-checkout', gateResult: outcome.gate! },
    { approvals, store: pgStore, nowMs: now },
  )
  check('second channel is idempotent (same row, created=false)', !tapped.created && tapped.action.action_id === merged.action.action_id)
  check('still exactly one landing after both channels fired', (await restart.listByClass(ctx.classKey)).length === 1)

  console.log(`\n${fail === 0 ? '✅' : '❌'} human-confirmed repair (durable): ${ok} checks passed, ${fail} failed`)
} finally {
  await sql.end()
}
process.exit(fail > 0 ? 1 : 0)
