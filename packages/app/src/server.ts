/**
 * The deployable entry point. Reads config from the environment (populated from the gitignored
 * connectors/.env), wires the REAL adapters when their keys/inputs are present and falls back to fakes
 * otherwise, and serves the fetch handler. This module is thin glue over the tested runtime; it holds
 * no key literals (everything via @sho/adapters env helpers).
 *
 *   bun run packages/app/src/server.ts
 */

import { SQL } from 'bun'
import { criticalityFromMap } from '@sho/aggregation'
import { InMemoryIncidentMemory, PostgresIncidentMemory, type Query } from '@sho/incident-memory'
import { NotifyStore, PgNotifyStore, KillSwitch, PgKillSwitch } from '@sho/orchestrator'
import { optionalEnv, proposeWithClaude, TelegramNotifier, realFetch } from '@sho/adapters'
import { GitBlameLog } from '@sho/rca-git'
import { createFetchHandler } from './http'
import { IncidentLog } from './oplog'
import type { AppDeps, DeliveryPayload, IncidentRecorder, NotifyGate, KillControl } from './runtime'

function renderDelivery(p: DeliveryPayload): string {
  return `[${p.gate}] ${p.incidentId} — ${p.hypothesis}\ncorrelation: ${p.correlationState}${p.suspicious ? ' ⚠ suspicious telemetry' : ''}\n→ ${p.recommendedAction}`
}

export function buildServerDeps(now: () => number): AppDeps {
  // Real Postgres when DATABASE_URL is set (run `bun run migrate` first); fakes otherwise.
  const dbUrl = optionalEnv('DATABASE_URL')
  const releaseToken = optionalEnv('KILL_RELEASE_TOKEN')
  let mem: IncidentRecorder
  let notify: NotifyGate
  let killSwitch: KillControl
  if (dbUrl) {
    const sql = new SQL(dbUrl)
    const query: Query = async (text, params) => (await sql.unsafe(text, (params ?? []) as never[])) as Record<string, unknown>[]
    mem = new PostgresIncidentMemory(query)
    notify = new PgNotifyStore(query) // durable notify_state CAS — no double-notify across restarts
    killSwitch = new PgKillSwitch(query, 30_000, releaseToken)
  } else {
    mem = new InMemoryIncidentMemory()
    notify = new NotifyStore()
    killSwitch = new KillSwitch(now(), 30_000, releaseToken)
  }
  const secret = optionalEnv('SIGNAL_SECRET')

  // Real LLM only when a key is present (rotated key, in connectors/.env — never in code).
  const apiKey = optionalEnv('ANTHROPIC_API_KEY')
  const propose = apiKey
    ? (input: Parameters<NonNullable<AppDeps['propose']>>[0]) => proposeWithClaude(input, { apiKey })
    : undefined

  // Real git-backed RCA grounding when RCA_GIT_REPO points at a checkout of the monitored service.
  const gitRepo = optionalEnv('RCA_GIT_REPO')
  const toolOverrides: AppDeps['toolOverrides'] = gitRepo ? { git: new GitBlameLog({ repo: gitRepo }) } : undefined

  // Real Telegram delivery + callback-answer when a token + chat are present.
  const tgToken = optionalEnv('TELEGRAM_BOT_TOKEN')
  const chat = optionalEnv('TELEGRAM_CHAT_ID')
  const deliverSinks: NonNullable<AppDeps['deliverSinks']> = []
  let answerCallback: AppDeps['answerCallback']
  if (tgToken && chat) {
    const tg = new TelegramNotifier({ token: tgToken })
    deliverSinks.push((p) => { tg.send({ chat, text: renderDelivery(p), buttons: [`ack:${p.incidentId}`] }, now()) })
    answerCallback = (id, text) => {
      void realFetch(`https://api.telegram.org/bot${tgToken}/answerCallbackQuery`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callback_query_id: id, text }),
      }).catch(() => {})
    }
  }

  return {
    mem, notify, killSwitch, secret, criticality: criticalityFromMap({}), propose, toolOverrides, deliverSinks,
    oplog: new IncidentLog(),
    sentryClientSecret: optionalEnv('SENTRY_CLIENT_SECRET'),
    telegramWebhookSecret: optionalEnv('TELEGRAM_WEBHOOK_SECRET'),
    answerCallback,
  }
}

export function startServer(port = Number(optionalEnv('PORT') ?? 3000)) {
  const deps = buildServerDeps(() => Date.now())
  const handler = createFetchHandler(deps)
  // Bun global is available at runtime; guarded so importing this module never requires a running server.
  return (globalThis as { Bun?: { serve(o: unknown): unknown } }).Bun?.serve({ port, fetch: handler })
}

if (import.meta.main) {
  startServer()
  const on = (k: string) => (optionalEnv(k) ? 'on' : 'off')
  console.log(
    `AgenticSelfHealingCode — listening.  db=${on('DATABASE_URL')}  llm=${on('ANTHROPIC_API_KEY')}  ` +
    `telegram=${on('TELEGRAM_BOT_TOKEN')}  sentry-native=${on('SENTRY_CLIENT_SECRET')}  git-rca=${on('RCA_GIT_REPO')}`,
  )
}
