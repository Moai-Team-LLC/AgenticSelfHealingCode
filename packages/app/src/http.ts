/**
 * The HTTP surface: a fetch handler (testable by calling with a Request — no port needed). server.ts
 * wraps it in Bun.serve. Two planes:
 *   - Ingest: POST /webhook/:source (attacker-reachable → signature verified inside handleSignal).
 *   - Ops: GET /incidents · GET /incidents/:id · GET /status · POST /kill · POST /release ·
 *          POST /telegram/callback. Kill/release are signed (HMAC over the body with SIGNAL_SECRET).
 */

import type { SignalSource } from '@sho/contracts'
import { verifyHmac } from '@sho/signal-layer'
import { ingestSentry } from '@sho/ingest-sentry'
import { handleSignal, diagnose, type AppDeps } from './runtime'

const SOURCE_RE = /^\/webhook\/(sentry|otel|rum|business-metric)$/
const json = (body: unknown, status = 200) => Response.json(body, { status })

/** A signed ops action: `x-signature` must be a valid HMAC of the raw body under SIGNAL_SECRET. */
function signedOk(req: Request, rawBody: string, deps: AppDeps): boolean {
  if (!deps.secret) return false // no server secret → no signed ops possible
  const sig = req.headers.get('x-signature') ?? ''
  return verifyHmac(rawBody, sig, deps.secret)
}

export function createFetchHandler(deps: AppDeps): (req: Request) => Promise<Response> {
  const now = () => Date.now()
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const path = url.pathname

    // ── health ──
    if (req.method === 'GET' && path === '/health') return json({ ok: true })

    // ── ingest ──
    const wm = path.match(SOURCE_RE)
    if (req.method === 'POST' && wm) {
      const source = wm[1] as SignalSource
      const rawBody = await req.text()
      // Native Sentry webhook (different signature scheme) when a Client Secret is configured and the
      // Sentry header is present — otherwise our own HMAC format.
      const sentrySig = req.headers.get('sentry-hook-signature')
      if (source === 'sentry' && deps.sentryClientSecret && sentrySig) {
        const ing = ingestSentry(rawBody, sentrySig, deps.sentryClientSecret)
        if (!ing.ok) return json(ing, 400)
        return json(await diagnose(ing.candidate, ing.suspicious, deps), 200)
      }
      const signature = req.headers.get('x-signature') ?? undefined
      const result = await handleSignal(rawBody, source, { secret: deps.secret, signature }, deps)
      return json(result, result.ok ? 200 : 400)
    }

    // ── ops: read ──
    if (req.method === 'GET' && path === '/incidents') {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 50))
      return json({ incidents: deps.oplog?.list(limit) ?? [] })
    }
    if (req.method === 'GET' && path.startsWith('/incidents/')) {
      const id = decodeURIComponent(path.slice('/incidents/'.length))
      const e = deps.oplog?.get(id)
      return e ? json(e) : json({ error: 'not found' }, 404)
    }
    if (req.method === 'GET' && path === '/status') {
      const killed = deps.killSwitch ? await deps.killSwitch.isKilled(now()) : false
      return json({
        ok: true,
        killed,
        mode: killed ? 'diagnosis-only (kill switch engaged)' : 'active',
        incidents: deps.oplog?.stats() ?? { total: 0, delivered: 0, escalated: 0, suspicious: 0, acked: 0 },
        adapters: { llm: deps.propose ? 'live' : 'fake', telegram: (deps.deliverSinks?.length ?? 0) > 0 ? 'live' : 'none' },
      })
    }

    // ── ops: kill switch (signed) ──
    if (req.method === 'POST' && (path === '/kill' || path === '/release')) {
      if (!deps.killSwitch) return json({ error: 'kill switch not configured' }, 503)
      const rawBody = await req.text()
      if (!signedOk(req, rawBody, deps)) return json({ error: 'bad_signature' }, 401)
      if (path === '/kill') {
        await deps.killSwitch.engage()
        return json({ ok: true, killed: true })
      }
      const token = (safeParse(rawBody) as { token?: string })?.token ?? ''
      const killed = await deps.killSwitch.release(token, now())
      return json({ ok: !killed, killed })
    }

    // ── Telegram callback (approve / reject / ack from an inline button) ──
    if (req.method === 'POST' && path === '/telegram/callback') {
      if (deps.telegramWebhookSecret && req.headers.get('x-telegram-bot-api-secret-token') !== deps.telegramWebhookSecret) {
        return json({ error: 'unauthorized' }, 401)
      }
      const update = safeParse(await req.text()) as TelegramUpdate | null
      const cq = update?.callback_query
      if (!cq?.data) return json({ ok: true }) // not a callback we handle — always 200 for Telegram
      const [action, incidentId = ''] = cq.data.split(':')
      const by = cq.from?.username ?? cq.from?.id?.toString() ?? 'unknown'
      const acked = incidentId ? (deps.oplog?.markAck(incidentId, by, new Date().toISOString()) ?? false) : false
      deps.telemetry?.emit({ kind: 'rca_outcome', at: new Date().toISOString(), incidentId, data: { humanAction: action, by, acked } })
      if (cq.id) await deps.answerCallback?.(cq.id, acked ? `${action} recorded` : 'received')
      return json({ ok: true })
    }

    return new Response('not found', { status: 404 })
  }
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s) } catch { return null }
}

interface TelegramUpdate {
  callback_query?: {
    id?: string
    data?: string
    from?: { id?: number; username?: string }
  }
}
