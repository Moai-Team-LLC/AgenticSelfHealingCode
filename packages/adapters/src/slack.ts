/**
 * Slack adapter for the L1 confirm channel — the sibling of the Telegram one. Three halves, all offline-testable
 * via an injected fetch and NEVER holding a token literal:
 *   - `SlackNotifier` — posts the proposal (human-readable error + fix) with Approve / Reject buttons (Block Kit).
 *   - `verifySlackSignature` — verifies the `x-slack-signature` (v0 HMAC over `v0:timestamp:body`) + replay window.
 *   - `parseSlackAction` — decodes the interactive callback (`application/x-www-form-urlencoded`, a `payload` JSON).
 *
 * The bot token (xoxb-, chat:write) and signing secret are passed in by the caller from the gitignored
 * connectors/.env. Buttons carry the same callback strings as Telegram (`approve:<id>` / `reject:<id>`) so both
 * channels route through the one confirmRepair; Slack additionally renders nice labels + primary/danger styling.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { FetchLike } from './env'
import { realFetch } from './env'

export interface SlackOptions {
  token: string
  fetchFn?: FetchLike
  apiBase?: string
  onError?: (e: unknown) => void
}

function buttonLabel(callback: string): string {
  if (callback.startsWith('approve')) return '✅ Approve'
  if (callback.startsWith('reject')) return '❌ Reject'
  return callback
}

export class SlackNotifier {
  constructor(private readonly opts: SlackOptions) {}

  /** Post a message with Approve/Reject buttons. Fire-and-forget (the durable approval row is the truth). */
  send(msg: { channel: string; text: string; buttons: string[] }): void {
    const f = this.opts.fetchFn ?? realFetch
    const elements = msg.buttons.map((b) => ({
      type: 'button',
      text: { type: 'plain_text', text: buttonLabel(b) },
      action_id: b,
      value: b,
      ...(b.startsWith('approve') ? { style: 'primary' } : b.startsWith('reject') ? { style: 'danger' } : {}),
    }))
    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: msg.text } },
      ...(elements.length ? [{ type: 'actions', elements }] : []),
    ]
    void f(`${this.opts.apiBase ?? 'https://slack.com/api'}/chat.postMessage`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.opts.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ channel: msg.channel, text: msg.text, blocks }),
    }).catch((e) => this.opts.onError?.(e))
  }
}

/**
 * Verify a Slack request signature over the RAW body (Slack signs `v0:timestamp:body`). When `nowMs` is given,
 * also reject a stale timestamp (> 5 min) to block replay. Constant-time compare.
 */
export function verifySlackSignature(
  rawBody: string,
  timestamp: string | null,
  signature: string | null,
  signingSecret: string,
  nowMs?: number,
): boolean {
  if (!timestamp || !signature) return false
  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return false
  if (nowMs !== undefined && Math.abs(nowMs / 1000 - ts) > 300) return false // 5-minute replay window
  const expected = 'v0=' + createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`, 'utf8').digest('hex')
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export interface SlackAction {
  value: string // the button's callback (e.g. "approve:<approvalId>")
  user: string // who clicked — descriptive audit only
}

/** Decode a Slack interactive callback body (form-encoded `payload=<json>`) → the clicked action, or null. */
export function parseSlackAction(rawBody: string): SlackAction | null {
  const payloadStr = new URLSearchParams(rawBody).get('payload')
  if (!payloadStr) return null
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(payloadStr) as Record<string, unknown>
  } catch {
    return null
  }
  const actions = payload.actions as { value?: string; action_id?: string }[] | undefined
  const first = actions?.[0]
  const value = first?.value ?? first?.action_id
  if (typeof value !== 'string') return null
  const u = payload.user as { username?: string; name?: string; id?: string } | undefined
  return { value, user: u?.username ?? u?.name ?? u?.id ?? 'unknown' }
}
