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
import { confirmRepair, rejectRepair } from '@sho/loop-c'
import { verifyGithubSignature, parseMergedPr } from '@sho/adapters'
import { handleSignal, diagnose, type AppDeps } from './runtime'
import type { RepairDeps } from './runtime'

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

    // ── GitHub PR-merge webhook → confirm a Loop C repair (channel 1) ──
    if (req.method === 'POST' && path === '/webhook/github') {
      const repair = deps.repair
      if (!repair?.githubWebhookSecret) return json({ error: 'repair webhook not configured' }, 503)
      const rawBody = await req.text()
      if (!verifyGithubSignature(rawBody, req.headers.get('x-hub-signature-256'), repair.githubWebhookSecret)) {
        return json({ error: 'bad_signature' }, 401)
      }
      const merged = parseMergedPr(safeParse(rawBody))
      if (!merged) return json({ ok: true, ignored: 'not a merged PR' }) // pings/opens/closed-without-merge
      const rec = repair.index.byPrNumber(merged.number)
      if (!rec) return json({ ok: true, ignored: 'no tracked repair for this PR' })
      try {
        const res = await confirmRepair(
          {
            approvalId: rec.approvalId, verdictBy: `github:${merged.mergedBy}`, parentSha: rec.parentSha,
            moduleArea: rec.moduleArea, classKey: rec.classKey, accountableOwner: rec.accountableOwner,
            gateResult: rec.gateResult, mergedFixSha: merged.mergeCommitSha || merged.headSha || rec.fixSha,
          },
          { approvals: repair.approvals, store: repair.store, nowMs: now(), telemetry: deps.telemetry },
        )
        repair.index.setStatus(rec.approvalId, 'confirmed')
        return json({ ok: true, landed: res.created, actionId: res.action.action_id })
      } catch (e) {
        return json({ ok: true, error: (e as Error).message }) // 200 so GitHub does not retry-storm
      }
    }

    // ── Telegram callback (approve / reject a repair · ack an alert) — channel 2 ──
    if (req.method === 'POST' && path === '/telegram/callback') {
      if (deps.telegramWebhookSecret && req.headers.get('x-telegram-bot-api-secret-token') !== deps.telegramWebhookSecret) {
        return json({ error: 'unauthorized' }, 401)
      }
      const update = safeParse(await req.text()) as TelegramUpdate | null
      const cq = update?.callback_query
      if (!cq?.data) return json({ ok: true }) // not a callback we handle — always 200 for Telegram
      const [action, ref = ''] = cq.data.split(':')
      const by = cq.from?.username ?? cq.from?.id?.toString() ?? 'unknown'
      let resultText = 'received'

      if ((action === 'approve' || action === 'reject') && deps.repair) {
        resultText = await handleRepairCallback(deps.repair, action, ref, by, now, deps)
      } else {
        // ack:<incidentId> — the enriched-alert acknowledgement path
        const acked = ref ? (deps.oplog?.markAck(ref, by, new Date().toISOString()) ?? false) : false
        deps.telemetry?.emit({ kind: 'rca_outcome', at: new Date().toISOString(), incidentId: ref, data: { humanAction: action, by, acked } })
        resultText = acked ? `${action} recorded` : 'received'
      }
      if (cq.id) await deps.answerCallback?.(cq.id, resultText)
      return json({ ok: true })
    }

    return new Response('not found', { status: 404 })
  }
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s) } catch { return null }
}

/** Telegram approve/reject → confirmRepair/rejectRepair. Returns the button-answer text; never throws. */
async function handleRepairCallback(
  repair: RepairDeps,
  action: 'approve' | 'reject',
  approvalId: string,
  by: string,
  now: () => number,
  deps: AppDeps,
): Promise<string> {
  const rec = repair.index.byApprovalId(approvalId)
  if (!rec) return 'no matching proposal'
  try {
    if (action === 'approve') {
      const res = await confirmRepair(
        {
          approvalId: rec.approvalId, verdictBy: by, parentSha: rec.parentSha, moduleArea: rec.moduleArea,
          classKey: rec.classKey, accountableOwner: rec.accountableOwner, gateResult: rec.gateResult,
        },
        { approvals: repair.approvals, store: repair.store, nowMs: now(), telemetry: deps.telemetry },
      )
      repair.index.setStatus(rec.approvalId, 'confirmed')
      return res.created ? 'approved — landing recorded' : 'already landed'
    }
    rejectRepair(rec.approvalId, by, { approvals: repair.approvals, nowMs: now() })
    repair.index.setStatus(rec.approvalId, 'rejected')
    return 'rejected'
  } catch (e) {
    return (e as Error).message
  }
}

interface TelegramUpdate {
  callback_query?: {
    id?: string
    data?: string
    from?: { id?: number; username?: string }
  }
}
