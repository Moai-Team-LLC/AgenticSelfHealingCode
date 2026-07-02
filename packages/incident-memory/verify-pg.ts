/**
 * Live verification of the @sho/incident-memory Postgres path against a real pg16 + pgvector.
 * Not a unit test (needs a DB) — run explicitly:  DATABASE_URL=... bun run verify-pg.ts
 *
 * Proves: the contract MIGRATIONS build on real Postgres, the freeze trigger fires, the adapter's
 * parameterized read queries (projectOutcomeEvents / detectRecurrence / harmQuery) return correct
 * results, and pgvector distance ops work on the why_traces embedding column.
 */

import { SQL } from 'bun'
import { PostgresIncidentMemory, type Query } from './src/postgres'
import { symptomSignatureOf, moduleAreaOf } from './src/memory'
import type { IncidentCandidate } from '@sho/contracts'

const url = process.env.DATABASE_URL
if (!url) { console.error('set DATABASE_URL'); process.exit(2) }
const sql = new SQL(url)
const query: Query = async (text, params) => (await sql.unsafe(text, (params ?? []) as never[])) as Record<string, unknown>[]

let ok = 0, fail = 0
const check = (name: string, cond: boolean, extra = '') => { cond ? ok++ : fail++; console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? `  — ${extra}` : ''}`) }
const DAY = 86_400_000
const now = Date.now()

try {
  // ── schema present (migrations were applied via psql before this script) ──
  const tabs = (await query(`SELECT table_schema||'.'||table_name t FROM information_schema.tables WHERE table_schema IN ('orch','incident_memory','trust')`)).map((r) => r.t)
  const tset = new Set(tabs)
  check('orch.auto_action', tset.has('orch.auto_action'))
  check('incident_memory.resolutions', tset.has('incident_memory.resolutions'))
  check('incident_memory.incidents', tset.has('incident_memory.incidents'))
  check('incident_memory.why_traces', tset.has('incident_memory.why_traces'))
  check('trust.trust_class', tset.has('trust.trust_class'))
  const ext = await query(`SELECT extname FROM pg_extension WHERE extname='vector'`)
  check('pgvector extension installed', ext.length === 1)
  const trig = await query(`SELECT tgname FROM pg_trigger WHERE tgname='resolutions_freeze'`)
  check('freeze trigger installed', trig.length === 1)

  // clean slate so counts are deterministic across re-runs
  await query(`TRUNCATE orch.auto_action, incident_memory.resolutions, incident_memory.incidents, incident_memory.why_traces CASCADE`)

  // ── seed a class: 1 auto_action (machine, 40d old) + a confirmed_good resolution ──
  const classKey = 'src/checkout::TypeError'
  const incId = crypto.randomUUID()
  const actId = crypto.randomUUID()
  const appliedAt = now - 40 * DAY
  const gate = JSON.stringify({ pass: true })
  await query(`INSERT INTO orch.auto_action (action_id, incident_id, class_key, loop, applied_by, applied_at, fix_sha, parent_sha, gate_result, accountable_owner, module_area)
               VALUES ($1,$2,$3,'C','machine',to_timestamp($4/1000.0),'fix1','par1',$5::jsonb,'@owner','src/checkout')`,
    [actId, incId, classKey, appliedAt, gate])
  const resId = crypto.randomUUID()
  await query(`INSERT INTO incident_memory.resolutions (id, incident_id, auto_action_id, ck_outcome_label, created_at)
               VALUES ($1,$2,$3,'confirmed_good',to_timestamp($4/1000.0))`, [resId, incId, actId, appliedAt])

  const mem = new PostgresIncidentMemory(query)

  // ── projectOutcomeEvents: applied + matured (matured only after W_mature=30d; 40d old qualifies) ──
  const events = await mem.projectOutcomeEvents(classKey, now)
  check('projectOutcomeEvents emits applied', events.some((e) => e.kind === 'applied' && e.actionId === actId))
  check('projectOutcomeEvents matures after W_mature', events.some((e) => e.kind === 'matured' && e.actionId === actId), `${events.map((e) => e.kind).join('+')}`)

  // ── detectRecurrence: seed an incident, then a candidate with the same fingerprint recurs ──
  const cand: IncidentCandidate = { id: incId, source: 'sentry', fingerprint: 'fp-checkout-1', severity: 2, first_seen: new Date(now).toISOString(), occurrences: 3, affected_service: 'checkout', affected_paths: ['src/checkout/price.ts'], recent_deploys: [], shape: 'step', raw_payload: { error_class: 'TypeError', message: 'boom 123' } }
  await query(`INSERT INTO incident_memory.incidents (id, fingerprint, symptom_signature, module_area, first_seen)
               VALUES ($1,$2,$3,$4,to_timestamp($5/1000.0))`, [incId, cand.fingerprint, symptomSignatureOf(cand), moduleAreaOf(cand), now])
  const rec = await mem.detectRecurrence(cand, now)
  check('detectRecurrence finds the prior by fingerprint', rec.recurred && rec.basis === 'fingerprint', `basis=${rec.basis}`)

  // ── harmQuery: a caused (recurred) resolution on the same class → count 1 ──
  const harmAct = crypto.randomUUID(), harmInc = crypto.randomUUID(), harmRes = crypto.randomUUID()
  await query(`INSERT INTO orch.auto_action (action_id, incident_id, class_key, loop, applied_by, applied_at, fix_sha, parent_sha, gate_result, accountable_owner, module_area)
               VALUES ($1,$2,$3,'C','human_approved',now(),'fix2','par2','{}'::jsonb,'@owner','src/checkout')`, [harmAct, harmInc, classKey])
  await query(`INSERT INTO incident_memory.resolutions (id, incident_id, auto_action_id, ck_outcome_label, created_at)
               VALUES ($1,$2,$3,'recurred',now())`, [harmRes, harmInc, harmAct])
  const harm = await mem.harmQuery(classKey)
  check('harmQuery counts caused over both applied_by variants', harm === 1, `harm=${harm}`)

  // ── freeze trigger: re-pointing a set auto_action_id must raise ──
  let froze = false
  try { await query(`UPDATE incident_memory.resolutions SET auto_action_id=$1 WHERE id=$2`, [harmAct, resId]) }
  catch (e) { froze = /frozen/.test(String(e)) }
  check('freeze trigger blocks re-pointing auto_action_id', froze)

  // ── pgvector: insert a 1536-dim embedding and run a cosine (<=>) nearest query ──
  const vec = `[${Array(1536).fill(0).map((_, i) => (i === 0 ? 1 : 0)).join(',')}]`
  await query(`INSERT INTO incident_memory.why_traces (incident_id, trace, content_hash, embedding) VALUES ($1,'{}'::jsonb,$2,$3::vector)`, [incId, 'h1', vec])
  const near = await query(`SELECT id, embedding <=> $1::vector AS dist FROM incident_memory.why_traces ORDER BY embedding <=> $1::vector LIMIT 1`, [vec])
  check('pgvector cosine (<=>) query returns nearest', near.length === 1 && Number(near[0]!.dist) < 1e-6, `dist=${near[0]?.dist}`)

  // ── retrieveSimilar: outcome-weighted, block-split (attack #8) via the 0006_retrieve_fn function ──
  await query(`TRUNCATE orch.auto_action, incident_memory.resolutions, incident_memory.incidents, incident_memory.why_traces CASCADE`)
  const qvec = `[${Array(1536).fill(0).map((_, i) => (i === 0 ? 1 : 0)).join(',')}]`
  const seedRetrieval = async (label: string) => {
    const iid = crypto.randomUUID(), rid = crypto.randomUUID()
    await query(`INSERT INTO incident_memory.incidents (id, fingerprint) VALUES ($1,$2)`, [iid, 'fp-' + label])
    await query(`INSERT INTO incident_memory.why_traces (incident_id, trace, content_hash, embedding) VALUES ($1,'{}'::jsonb,$2,$3::vector)`, [iid, 'h-' + label, qvec])
    await query(`INSERT INTO incident_memory.resolutions (id, incident_id, ck_outcome_label, created_at) VALUES ($1,$2,$3,now())`, [rid, iid, label])
  }
  await seedRetrieval('confirmed_good')
  await seedRetrieval('applied')
  await seedRetrieval('reverted')
  await seedRetrieval('superseded')
  const rr = await mem.retrieveSimilar(qvec, 5)
  check('retrieveSimilar: 2 exemplars (confirmed_good + weak); superseded filtered', rr.exemplars.length === 2, `exemplars=${rr.exemplars.map((e) => e.resolution.outcomeLabel).join(',')}`)
  check('retrieveSimilar: confirmed_good is the top exemplar (weight ranking)', rr.exemplars[0]?.resolution.outcomeLabel === 'confirmed_good' && rr.exemplars[0]?.polarity === 'exemplar')
  check('retrieveSimilar: weak positive present + labeled weak', rr.exemplars.some((e) => e.resolution.outcomeLabel === 'applied' && e.polarity === 'weak'))
  check('retrieveSimilar: reverted in the anti-pattern block, labeled', rr.antiPatterns.length === 1 && rr.antiPatterns[0]?.resolution.outcomeLabel === 'reverted' && rr.antiPatterns[0]?.polarity === 'anti-pattern')
  check('retrieveSimilar: superseded never returned', ![...rr.exemplars, ...rr.antiPatterns].some((h) => h.resolution.outcomeLabel === 'superseded'))

  console.log(`\n${fail === 0 ? '✅' : '❌'} incident-memory Postgres path: ${ok} checks passed, ${fail} failed`)
} finally {
  await sql.end()
}
process.exit(fail > 0 ? 1 : 0)
