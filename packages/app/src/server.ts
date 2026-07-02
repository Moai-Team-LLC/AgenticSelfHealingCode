/**
 * The deployable entry point. Reads config from the environment (populated from the gitignored
 * connectors/.env), wires the REAL adapters when their keys are present and falls back to fakes
 * otherwise, and serves the fetch handler. This module is thin glue over the tested runtime; it holds
 * no key literals (everything via @sho/adapters env helpers).
 *
 *   bun run packages/app/src/server.ts
 */

import { SQL } from 'bun'
import { criticalityFromMap } from '@sho/aggregation'
import { InMemoryIncidentMemory, PostgresIncidentMemory, type Query } from '@sho/incident-memory'
import { NotifyStore, PgNotifyStore } from '@sho/orchestrator'
import { optionalEnv, proposeWithClaude, TelegramNotifier } from '@sho/adapters'
import { createFetchHandler } from './http'
import type { AppDeps, DeliveryPayload, IncidentRecorder, NotifyGate } from './runtime'

function renderDelivery(p: DeliveryPayload): string {
  return `[${p.gate}] ${p.incidentId} — ${p.hypothesis}\ncorrelation: ${p.correlationState}${p.suspicious ? ' ⚠ suspicious telemetry' : ''}\n→ ${p.recommendedAction}`
}

export function buildServerDeps(now: () => number): AppDeps {
  // Real Postgres when DATABASE_URL is set (apply the contract MIGRATIONS via psql first); fake otherwise.
  const dbUrl = optionalEnv('DATABASE_URL')
  let mem: IncidentRecorder
  let notify: NotifyGate
  if (dbUrl) {
    const sql = new SQL(dbUrl)
    const query: Query = async (text, params) => (await sql.unsafe(text, (params ?? []) as never[])) as Record<string, unknown>[]
    mem = new PostgresIncidentMemory(query)
    notify = new PgNotifyStore(query) // durable notify_state CAS — no double-notify across restarts
  } else {
    mem = new InMemoryIncidentMemory()
    notify = new NotifyStore()
  }
  const secret = optionalEnv('SIGNAL_SECRET')

  // Real LLM only when a key is present (rotated key, in connectors/.env — never in code).
  const apiKey = optionalEnv('ANTHROPIC_API_KEY')
  const propose = apiKey
    ? (input: Parameters<NonNullable<AppDeps['propose']>>[0]) => proposeWithClaude(input, { apiKey })
    : undefined

  // Real Telegram delivery only when a token + chat are present.
  const deliverSinks: NonNullable<AppDeps['deliverSinks']> = []
  const tgToken = optionalEnv('TELEGRAM_BOT_TOKEN')
  const chat = optionalEnv('TELEGRAM_CHAT_ID')
  if (tgToken && chat) {
    const tg = new TelegramNotifier({ token: tgToken })
    deliverSinks.push((p) => { tg.send({ chat, text: renderDelivery(p), buttons: ['ack'] }, now()) })
  }

  return { mem, notify, secret, criticality: criticalityFromMap({}), propose, deliverSinks }
}

export function startServer(port = Number(optionalEnv('PORT') ?? 3000)) {
  const deps = buildServerDeps(() => Date.now())
  const handler = createFetchHandler(deps)
  // Bun global is available at runtime; guarded so importing this module never requires a running server.
  return (globalThis as { Bun?: { serve(o: unknown): unknown } }).Bun?.serve({ port, fetch: handler })
}

if (import.meta.main) {
  startServer()
  console.log(`Self-Healing Ops — signal intake listening. Real adapters: LLM=${optionalEnv('ANTHROPIC_API_KEY') ? 'on' : 'fake'}, Telegram=${optionalEnv('TELEGRAM_BOT_TOKEN') ? 'on' : 'fake'}`)
}
