#!/usr/bin/env bun
/**
 * LIVE smoke of the two key-gated adapters — ONE real Claude hypothesis, then ONE real Telegram send of
 * that hypothesis (the actual RCA→delivery hop). Keys are read ONLY from connectors/.env (gitignored);
 * this script never hardcodes or prints a key. Dogfoods the real adapters (@sho/adapters).
 *
 * You run this (I never handle the raw keys):
 *   1) rotate the token + key you pasted in chat, then put the NEW ones in connectors/.env:
 *        ANTHROPIC_API_KEY=...   TELEGRAM_BOT_TOKEN=...   TELEGRAM_CHAT_ID=...
 *   2) bun run packages/app/smoke-live.ts
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { IncidentCandidate } from '@sho/contracts'
import { proposeWithClaude, TelegramNotifier, requireEnv, realFetch, type FetchLike } from '@sho/adapters'

// Load connectors/.env (repo-root/connectors/.env), same convention as connectors/*-pull.ts. No override.
function loadEnv() {
  const p = join(import.meta.dir, '../../connectors/.env')
  if (!existsSync(p)) { console.error(`connectors/.env not found — copy connectors/.env.example → connectors/.env and fill in ROTATED keys.`); process.exit(2) }
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}

const candidate: IncidentCandidate = {
  id: 'smoke-1', source: 'sentry', fingerprint: 'TypeError_checkout_price', severity: 3, first_seen: new Date().toISOString(),
  occurrences: 12, affected_service: 'checkout', affected_paths: ['src/checkout/price.ts'],
  recent_deploys: [{ deploy_id: 'd1', ts: new Date(Date.now() - 3_600_000).toISOString() }], shape: 'step',
  raw_payload: { error_class: 'TypeError', message: "cannot read 'id' of undefined" },
}

async function main() {
  loadEnv()
  let pass = 0, failn = 0
  const line = (c: boolean, s: string) => { c ? pass++ : failn++; console.log(`  ${c ? '✓' : '✗'} ${s}`) }

  // ── 1) real Claude hypothesis ──
  let hypothesis = ''
  try {
    const proposal = await proposeWithClaude({ candidate, evidenceSummary: 'deploy_linked; repro reproduced' }, { apiKey: requireEnv('ANTHROPIC_API_KEY'), fetchFn: realFetch })
    hypothesis = proposal.primary.statement
    line(hypothesis.length > 0, `Claude live: hypothesis = "${hypothesis}" (fixClass=${proposal.primary.fixClass}, ${proposal.alternatives.length} alts)`)
  } catch (e) {
    line(false, `Claude live FAILED: ${String(e).slice(0, 200)}`)
  }

  // ── 2) real Telegram send of that hypothesis ──
  let tgErr = ''
  const capture: FetchLike = async (u, i) => {
    const r = await realFetch(u, i)
    const j = (await r.json()) as { ok?: boolean; description?: string }
    if (!j?.ok) tgErr = j?.description ?? `HTTP ${r.status}`
    return { ok: r.ok, status: r.status, json: async () => j, text: async () => JSON.stringify(j) }
  }
  try {
    const chat = requireEnv('TELEGRAM_CHAT_ID')
    const tg = new TelegramNotifier({ token: requireEnv('TELEGRAM_BOT_TOKEN'), fetchFn: capture, onError: (e) => (tgErr = String(e)) })
    tg.send({ chat, text: `🩺 Self-Healing Ops live smoke\n[ESCALATE] checkout — ${hypothesis || '(no LLM hypothesis)'}\ncorrelation: deploy_linked`, buttons: ['ack'] }, Date.now())
    await tg.drain()
    line(tgErr === '', tgErr === '' ? `Telegram live: message delivered to chat ${chat}` : `Telegram live FAILED: ${tgErr}`)
  } catch (e) {
    line(false, `Telegram live FAILED: ${String(e).slice(0, 200)}`)
  }

  console.log(`\n${failn === 0 ? '✅ live smoke passed' : '❌ live smoke failed'} — ${pass} ok, ${failn} failed`)
  process.exit(failn > 0 ? 1 : 0)
}

main()
