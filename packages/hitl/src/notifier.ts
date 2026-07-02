/**
 * §4 — THE TELEGRAM BOT surface, behind a `Notifier` interface. The bot is a VIEW + an ACTUATOR over the
 * durable `approval_request` row, never the source of truth (if the bot dies mid-approval the row is
 * intact and a new instance re-renders it). Telegram itself is a real adapter (thin code over an injected
 * bot client); the default here is an in-memory fake that RECORDS sent + edited messages so the render
 * contract is testable NOW with no network.
 *
 * `telegram_msg_ref` is stable per request: reminders EDIT the existing message (never spam new ones, §3.4).
 */

import type { ApprovalRequest } from './ladder'

/** A message the bot sent/edited. Content is opaque here — the render is exercised in tests via fields. */
export interface SentMessage {
  ref: string // telegram_msg_ref (chat/message id); stable per approval_request
  chat: string
  text: string
  buttons: string[] // inline button labels, e.g. ['approve','edit','reject']
  editedCount: number // 0 = first send; N = edited N times (reminder cadence, §3.4)
  atMs: number
}

export interface Notifier {
  /** Send (or, if `ref` already exists, edit-in-place) a message. Returns the stable ref. */
  send(msg: { ref?: string; chat: string; text: string; buttons: string[] }, nowMs: number): string
  /** The current view of a message by ref (for re-render / assertions). */
  get(ref: string): SentMessage | undefined
}

/** Fake, in-memory Notifier — the default. Records every send and every in-place edit. */
export class FakeNotifier implements Notifier {
  private byRef = new Map<string, SentMessage>()
  private seq = 0
  readonly log: { ref: string; kind: 'send' | 'edit'; atMs: number }[] = []

  send(msg: { ref?: string; chat: string; text: string; buttons: string[] }, nowMs: number): string {
    const existingRef = msg.ref
    const prior = existingRef ? this.byRef.get(existingRef) : undefined
    if (prior) {
      const updated: SentMessage = { ...prior, text: msg.text, buttons: msg.buttons, editedCount: prior.editedCount + 1, atMs: nowMs }
      this.byRef.set(prior.ref, updated)
      this.log.push({ ref: prior.ref, kind: 'edit', atMs: nowMs })
      return prior.ref
    }
    const ref = existingRef ?? `msg-${this.seq++}`
    const sent: SentMessage = { ref, chat: msg.chat, text: msg.text, buttons: msg.buttons, editedCount: 0, atMs: nowMs }
    this.byRef.set(ref, sent)
    this.log.push({ ref, kind: 'send', atMs: nowMs })
    return ref
  }

  get(ref: string): SentMessage | undefined { return this.byRef.get(ref) }
  sentCount(): number { return this.log.filter((l) => l.kind === 'send').length }
  editCount(ref: string): number { return this.byRef.get(ref)?.editedCount ?? 0 }
}

/** Render an approval_request into the compressed phone payload (§4.1). Kept minimal + deterministic. */
export function renderApproval(r: ApprovalRequest, opts: { offHours: boolean } = { offHours: false }): {
  chat: string
  text: string
  buttons: string[]
} {
  const buttons = r.tier === 4 ? ['approve', 'reject'] : ['approve', 'edit', 'reject']
  const banner = opts.offHours ? ' (off-hours: PR, will wait for you)' : ''
  const text =
    `Tier ${r.tier} · L${r.requestedLevel}` +
    (r.downgradedFrom !== null ? ` (downgraded from L${r.downgradedFrom})` : '') +
    `\nclass: ${r.classKey}${banner}\nstate: ${r.state} · why-trace ${r.whyTraceId}`
  return { chat: r.team, text, buttons }
}
