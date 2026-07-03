import { test, expect } from 'bun:test'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { InMemoryIncidentMemory } from '@sho/incident-memory'
import { NotifyStore, KillSwitch } from '@sho/orchestrator'
import { InMemoryTelemetry } from '@sho/contracts'
import { criticalityFromMap } from '@sho/aggregation'
import { createFetchHandler, IncidentLog, type AppDeps } from './src/index'

const SECRET = 'ops-secret'
const sign = (b: string) => createHmac('sha256', SECRET).update(b, 'utf8').digest('hex')
const signal = (id: string) => JSON.stringify({
  id, fingerprint: 'fp_' + id, service: 'checkout', severity: 3, occurrences: 4,
  affected_paths: ['src/checkout/price.ts'], first_seen: '2026-07-01T00:00:00Z', shape: 'step', title: 'TypeError',
})

function makeDeps(over: Partial<AppDeps> = {}) {
  const oplog = new IncidentLog()
  const telemetry = new InMemoryTelemetry()
  const killSwitch = new KillSwitch(Date.now(), 30_000, 'release-tok')
  const deps: AppDeps = {
    mem: new InMemoryIncidentMemory(), notify: new NotifyStore(), criticality: criticalityFromMap({ checkout: 5 }),
    secret: SECRET, oplog, telemetry, killSwitch, telegramWebhookSecret: 'tg-secret', ...over,
  }
  return { deps, oplog, telemetry, killSwitch, handler: createFetchHandler(deps) }
}

test('GET /incidents + /status reflect processed signals + telemetry emitted', async () => {
  const { handler, telemetry } = makeDeps()
  const b = signal('inc-1')
  await handler(new Request('http://x/webhook/sentry', { method: 'POST', headers: { 'x-signature': sign(b) }, body: b }))

  const incs = await (await handler(new Request('http://x/incidents'))).json()
  expect(incs.incidents).toHaveLength(1)
  expect(incs.incidents[0].incidentId).toBe('inc-1')

  const status = await (await handler(new Request('http://x/status'))).json()
  expect(status.killed).toBe(false)
  expect(status.incidents.total).toBe(1)
  expect(status.adapters).toEqual({ llm: 'fake', telegram: 'none' })
  expect(telemetry.events.some((e) => e.kind === 'rca_outcome' && e.incidentId === 'inc-1')).toBe(true)
})

test('POST /kill and /release require a valid signature; toggle killed state', async () => {
  const { handler } = makeDeps()
  const body = '{}'
  // unsigned → 401
  const bad = await handler(new Request('http://x/kill', { method: 'POST', body }))
  expect(bad.status).toBe(401)
  // signed kill → killed
  const kill = await handler(new Request('http://x/kill', { method: 'POST', headers: { 'x-signature': sign(body) }, body }))
  expect((await kill.json()).killed).toBe(true)
  const st = await (await handler(new Request('http://x/status'))).json()
  expect(st.killed).toBe(true)
  expect(st.mode).toContain('diagnosis-only')
  // wrong release token → stays killed
  const rb = JSON.stringify({ token: 'wrong' })
  const r1 = await handler(new Request('http://x/release', { method: 'POST', headers: { 'x-signature': sign(rb) }, body: rb }))
  expect((await r1.json()).killed).toBe(true)
  // right token → released
  const rb2 = JSON.stringify({ token: 'release-tok' })
  const r2 = await handler(new Request('http://x/release', { method: 'POST', headers: { 'x-signature': sign(rb2) }, body: rb2 }))
  expect((await r2.json()).killed).toBe(false)
})

test('Telegram callback acks an incident (auth by secret token)', async () => {
  const { handler, oplog } = makeDeps()
  const b = signal('inc-2')
  await handler(new Request('http://x/webhook/sentry', { method: 'POST', headers: { 'x-signature': sign(b) }, body: b }))

  const update = JSON.stringify({ callback_query: { id: 'cq1', data: 'ack:inc-2', from: { id: 7, username: 'oncall_jane' } } })
  // wrong secret → 401
  const bad = await handler(new Request('http://x/telegram/callback', { method: 'POST', body: update }))
  expect(bad.status).toBe(401)
  // right secret → acked
  const ok = await handler(new Request('http://x/telegram/callback', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'tg-secret' }, body: update }))
  expect(ok.status).toBe(200)
  expect(oplog.get('inc-2')!.ackedBy).toBe('oncall_jane')
})

test('native Sentry webhook (sentry-hook-signature) flows through to diagnosis', async () => {
  const CLIENT_SECRET = 'sentry-client-secret'
  const { deps, oplog } = makeDeps({ sentryClientSecret: CLIENT_SECRET })
  const handler = createFetchHandler(deps)
  const body = readFileSync(new URL('../ingest-sentry/fixtures/error-event.json', import.meta.url), 'utf8')
  const sig = createHmac('sha256', CLIENT_SECRET).update(body, 'utf8').digest('hex')

  const res = await handler(new Request('http://x/webhook/sentry', {
    method: 'POST', headers: { 'sentry-hook-signature': sig, 'sentry-hook-resource': 'error' }, body,
  }))
  expect(res.status).toBe(200)
  const r = await res.json()
  expect(r.ok).toBe(true)
  expect(oplog.stats().total).toBe(1) // the real Sentry event was diagnosed and logged

  // a tampered body is rejected by the Sentry signature check (not our x-signature)
  const bad = await handler(new Request('http://x/webhook/sentry', {
    method: 'POST', headers: { 'sentry-hook-signature': sig, 'sentry-hook-resource': 'error' }, body: body + ' ',
  }))
  expect(bad.status).toBe(400)
})

test('IncidentLog is a bounded ring buffer', () => {
  const log = new IncidentLog(2)
  for (const id of ['a', 'b', 'c']) log.record({ incidentId: id, classKey: 'k', gate: 'CONFIRMED', correlationState: 'x', priority: 1, delivered: true, suspicious: false, at: '2026-07-01T00:00:00Z' })
  expect(log.list().map((e) => e.incidentId)).toEqual(['c', 'b']) // 'a' evicted, most-recent first
})
