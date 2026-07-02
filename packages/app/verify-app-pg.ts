/**
 * Live end-to-end on real Postgres: a signed webhook → the app handler (DATABASE_URL set → Postgres mem
 * + durable PgNotifyStore) → incident persisted + delivered once. Then a SECOND process (fresh deps,
 * same DB = a restart) sends the SAME webhook and is NOT re-delivered — the durable notify_state CAS
 * survives restarts. No API keys needed (LLM falls back to fake).
 *   DATABASE_URL=… SIGNAL_SECRET=… bun run verify-app-pg.ts
 */

import { createHmac } from 'node:crypto'
import { SQL } from 'bun'
import { buildServerDeps, createFetchHandler } from './src/index'

const url = process.env.DATABASE_URL
if (!url) { console.error('set DATABASE_URL'); process.exit(2) }
const secret = process.env.SIGNAL_SECRET ?? 'app-secret'
process.env.SIGNAL_SECRET = secret
const sql = new SQL(url)
let ok = 0, fail = 0
const check = (n: string, c: boolean, e = '') => { c ? ok++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${n}${e ? `  — ${e}` : ''}`) }

await sql.unsafe(`TRUNCATE incident_memory.incidents CASCADE`)

const incId = crypto.randomUUID()
const body = JSON.stringify({ id: incId, fingerprint: 'fp-live', service: 'checkout', occurrences: 2, affected_paths: ['src/checkout/price.ts'], first_seen: new Date().toISOString(), shape: 'step', title: 'live e2e' })
const sig = createHmac('sha256', secret).update(body, 'utf8').digest('hex')
const req = () => new Request('http://x/webhook/sentry', { method: 'POST', headers: { 'x-signature': sig }, body })

try {
  // ── process 1 ──
  const h1 = createFetchHandler(buildServerDeps(() => Date.now()))
  const r1 = await (await h1(req())).json()
  check('process 1: signed webhook accepted', r1.ok === true, `gate=${r1.gate} corr=${r1.correlationState}`)
  check('process 1: delivered (durable notify CAS won)', r1.delivered === true)
  const rows = (await sql.unsafe(`SELECT id, notify_state FROM incident_memory.incidents WHERE id=$1`, [incId] as never[])) as Record<string, unknown>[]
  check('incident persisted to real Postgres', rows.length === 1, JSON.stringify(rows[0]))
  check('notify_state durably = notified', rows[0]?.notify_state === 'notified')

  // ── process 2 = a RESTART: brand-new deps + handler on the SAME DB ──
  const h2 = createFetchHandler(buildServerDeps(() => Date.now()))
  const r2 = await (await h2(req())).json()
  check('process 2 (restart): same incident NOT re-delivered (durable no-double-notify)', r2.ok === true && r2.delivered === false)

  console.log(`\n${fail === 0 ? '✅' : '❌'} live app→Postgres (durable notify): ${ok} checks passed, ${fail} failed`)
} finally {
  await sql.end()
}
process.exit(fail > 0 ? 1 : 0)
