/**
 * TelegramNotifier — the real @sho/hitl Notifier adapter (thin actuator over the Telegram Bot API).
 *
 * The Notifier interface is synchronous because the durable approval_request row is the source of
 * truth, not the message (HITL-APPROVAL §4): send() returns a stable ref immediately and fires the
 * HTTP call fire-and-forget; if it fails the row is intact and a re-render recovers. Reminders EDIT the
 * existing message (never spam). The bot token is read from env by the caller and passed in — this
 * module never holds a literal token. `fetchFn` is injected so the actuator logic is testable offline.
 */

import type { Notifier, SentMessage } from '@sho/hitl'
import type { FetchLike } from './env'
import { realFetch } from './env'

interface TgRecord extends SentMessage { tgMessageId?: number }

export interface TelegramOptions {
  token: string
  fetchFn?: FetchLike
  onError?: (e: unknown) => void
}

export class TelegramNotifier implements Notifier {
  private readonly byRef = new Map<string, TgRecord>()
  private seq = 0
  private inFlight: Promise<void>[] = []
  constructor(private readonly opts: TelegramOptions) {}

  send(msg: { ref?: string; chat: string; text: string; buttons: string[] }, nowMs: number): string {
    const existing = msg.ref ? this.byRef.get(msg.ref) : undefined
    const ref = msg.ref ?? `tg-${this.seq++}`
    const rec: TgRecord = existing
      ? { ...existing, text: msg.text, buttons: msg.buttons, editedCount: existing.editedCount + 1, atMs: nowMs }
      : { ref, chat: msg.chat, text: msg.text, buttons: msg.buttons, editedCount: 0, atMs: nowMs }
    this.byRef.set(ref, rec)
    this.inFlight.push(this.dispatch(ref, existing?.tgMessageId).catch((e) => this.opts.onError?.(e)))
    return ref
  }

  private async dispatch(ref: string, tgMessageId: number | undefined): Promise<void> {
    const rec = this.byRef.get(ref)
    if (!rec) return
    const base = `https://api.telegram.org/bot${this.opts.token}`
    const f = this.opts.fetchFn ?? realFetch
    const reply_markup = { inline_keyboard: [rec.buttons.map((b) => ({ text: b, callback_data: b }))] }
    const headers = { 'content-type': 'application/json' }
    if (tgMessageId !== undefined) {
      await f(`${base}/editMessageText`, { method: 'POST', headers, body: JSON.stringify({ chat_id: rec.chat, message_id: tgMessageId, text: rec.text, reply_markup }) })
      return
    }
    const res = await f(`${base}/sendMessage`, { method: 'POST', headers, body: JSON.stringify({ chat_id: rec.chat, text: rec.text, reply_markup }) })
    const json = (await res.json()) as { result?: { message_id?: number } }
    const id = json?.result?.message_id
    if (typeof id === 'number') { const cur = this.byRef.get(ref); if (cur) cur.tgMessageId = id }
  }

  /** Await all in-flight sends (for tests / graceful shutdown). Fire-and-forget otherwise. */
  async drain(): Promise<void> {
    const pending = this.inFlight
    this.inFlight = []
    await Promise.all(pending)
  }

  get(ref: string): SentMessage | undefined {
    const r = this.byRef.get(ref)
    return r ? { ref: r.ref, chat: r.chat, text: r.text, buttons: r.buttons, editedCount: r.editedCount, atMs: r.atMs } : undefined
  }
}
