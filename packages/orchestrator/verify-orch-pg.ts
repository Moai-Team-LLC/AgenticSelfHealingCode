/**
 * Live verification of the DURABLE orchestrator against real Postgres (D1/§11). The headline is
 * restart-survival: a fresh store instance (= a new process) reads exactly the state the last one left.
 *   DATABASE_URL=… bun run verify-orch-pg.ts
 */

import { SQL } from 'bun'
import { PgAutoActionStore, applyTimeWriteAsync, PgNotifyStore, PgKillSwitch, type Query, type LandingInput } from './src/index'
import type { GateResult } from '@sho/contracts'

const url = process.env.DATABASE_URL
if (!url) { console.error('set DATABASE_URL'); process.exit(2) }
const sql = new SQL(url)
const query: Query = async (t, p) => (await sql.unsafe(t, (p ?? []) as never[])) as Record<string, unknown>[]
let ok = 0, fail = 0
const check = (n: string, c: boolean, e = '') => { c ? ok++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${n}${e ? `  — ${e}` : ''}`) }
const now = Date.now()
const gate: GateResult = { pass: true, moduleArea: 'src/checkout', signals: { mustFailOnParent: { pass: true, code: 'DISCRIMINATING' }, mutationScore: { pass: true, score: 1, threshold: 0.75 }, noWeakening: null, diffLines: 5, exceedsClassBudget: false }, reason: 'ok' }

try {
  await query(`TRUNCATE orch.auto_action, incident_memory.incidents CASCADE`)
  await query(`UPDATE orch.kill_switch SET engaged=false, heartbeat_at=now() WHERE id`)

  // ── 1. auto_action ledger: durable + idempotent apply-time write ──
  const store = new PgAutoActionStore(query)
  const incId = crypto.randomUUID(), classKey = 'src/checkout::T'
  const landing: LandingInput = { incident_id: incId, class_key: classKey, loop: 'C', applied_by: 'human_approved', fix_sha: 'f1', parent_sha: 'p1', gate_result: gate, accountable_owner: '@own', module_area: 'src/checkout', applied_at: new Date(now).toISOString() }
  const a = await applyTimeWriteAsync(store, landing)
  const b = await applyTimeWriteAsync(store, landing)
  check('auto_action: first apply-time write created', a.created)
  check('auto_action: redelivery idempotent (same row, no orphan)', !b.created && b.action.action_id === a.action.action_id)
  const store2 = new PgAutoActionStore(query) // ← simulate a process restart
  const got = await store2.getByIncidentFix(incId, 'f1')
  check('auto_action: SURVIVES RESTART (fresh instance reads the row)', got?.action_id === a.action.action_id, `applied_by=${got?.applied_by}`)
  check('auto_action: listByClass finds it', (await store2.listByClass(classKey)).length === 1)

  // ── 2. notify_state: durable CAS (no double-notify across restart) ──
  await query(`INSERT INTO incident_memory.incidents (id, fingerprint) VALUES ($1,'fp')`, [incId])
  const notify = new PgNotifyStore(query)
  check('notify: first CAS transitions investigating→notified', await notify.casNotified(incId))
  check('notify: second CAS is a no-op', !(await notify.casNotified(incId)))
  const notify2 = new PgNotifyStore(query) // ← restart
  check('notify: SURVIVES RESTART (still notified, never double-notifies)', !(await notify2.casNotified(incId)) && (await notify2.get(incId)) === 'notified')

  // ── 3. kill bit: durable + the restart-survival headline ──
  const kill = new PgKillSwitch(query, 30_000, 'release-tok')
  await kill.heartbeat(now)
  check('kill: healthy heartbeat → not killed', !(await kill.isKilled(now)))
  await kill.engage()
  check('kill: engaged → killed', await kill.isKilled(now))
  const killRestart = new PgKillSwitch(query, 30_000, 'release-tok') // ← NEW process
  check('kill: SURVIVES RESTART (fresh instance still killed)', await killRestart.isKilled(now))
  check('kill: signed release clears it', !(await killRestart.release('release-tok', now)))
  await kill.engage()
  check('kill: wrong token cannot release', await kill.release('wrong', now))
  await kill.release('release-tok', now)
  await kill.heartbeat(now)
  check('kill: stale heartbeat → killed (fail-safe)', await kill.isKilled(now + 60_000))

  console.log(`\n${fail === 0 ? '✅' : '❌'} durable orchestrator: ${ok} checks passed, ${fail} failed`)
} finally {
  await sql.end()
}
process.exit(fail > 0 ? 1 : 0)
