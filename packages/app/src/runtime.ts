/**
 * The composed runtime: one raw signal → the whole diagnosis half of the pipeline, on injected deps.
 * This is the "product as a service" seam — signal-layer → aggregation → incident-memory → loop-a →
 * delivery (notify CAS + sinks). Loop A is Tier 1: this path NEVER writes app code. The (async) LLM call
 * is injected via `deps.propose` and awaited OUTSIDE loop-a's deterministic investigate.
 */

import type { SignalSource, WhyTrace, TelemetrySink } from '@sho/contracts'
import { ingest } from '@sho/signal-layer'
import { fingerprint, moduleArea, symptomSignature, priority, type BusinessCriticality } from '@sho/aggregation'
import { investigate, fakeTools, FakeLlmClient, type RcaTools, type LlmProposal } from '@sho/loop-a'
import type { IncidentRecord } from '@sho/incident-memory'
import type { IncidentLog } from './oplog'

/** The kill-switch controls the ops surface reads/toggles. In-memory KillSwitch or PgKillSwitch both fit. */
export interface KillControl {
  isKilled(nowMs: number): boolean | Promise<boolean>
  engage(): void | Promise<void>
  release(token: string, nowMs: number): boolean | Promise<boolean>
}

/** The app only records incidents. recordIncident may be sync (in-memory) or async (Postgres); the
 *  runtime AWAITS it so the incident row lands before the notify_state CAS reads it. */
export interface IncidentRecorder {
  recordIncident(rec: IncidentRecord): void | Promise<void>
}

/** The delivery gate: the durable notify_state CAS. In-memory NotifyStore (sync) or PgNotifyStore (async). */
export interface NotifyGate {
  casNotified(incidentId: string): boolean | Promise<boolean>
}

export interface DeliveryPayload {
  incidentId: string
  hypothesis: string
  correlationState: WhyTrace['correlationState']
  gate: 'CONFIRMED' | 'ESCALATE'
  recommendedAction: string
  suspicious: boolean
}

export interface AppDeps {
  mem: IncidentRecorder
  notify: NotifyGate
  criticality: BusinessCriticality
  secret?: string
  /** async hypothesis proposer (real: @sho/adapters proposeWithClaude). Omitted → deterministic fake. */
  propose?: (input: { candidate: import('@sho/contracts').IncidentCandidate; evidenceSummary: string }) => Promise<LlmProposal>
  toolOverrides?: Partial<RcaTools>
  /** where a delivered why-trace payload goes (real: a Telegram send). */
  deliverSinks?: ((payload: DeliveryPayload) => void)[]
  /** the ops read-model (GET /incidents, /status). Optional; absent → those endpoints report empty. */
  oplog?: IncidentLog
  /** the kill switch behind GET /status + POST /kill|/release. Optional. */
  killSwitch?: KillControl
  /** ecosystem telemetry (AgenticOps/APL). Optional; emitted on each diagnosed incident. */
  telemetry?: TelemetrySink
  /** Sentry integration Client Secret. Set → the /webhook/sentry endpoint accepts NATIVE Sentry webhooks
   *  (verified via the `sentry-hook-signature` header) in addition to our own HMAC format. */
  sentryClientSecret?: string
  /** secret_token configured on the Telegram webhook; the callback endpoint checks it (fail-closed if set). */
  telegramWebhookSecret?: string
  /** answer a Telegram callback_query (clears the button spinner). Real: TelegramNotifier. */
  answerCallback?: (callbackQueryId: string, text: string) => void | Promise<void>
}

export type SignalResult =
  | { ok: false; reason: string }
  | { ok: true; incidentId: string; classKey: string; priority: number; gate: 'CONFIRMED' | 'ESCALATE'; correlationState: WhyTrace['correlationState']; delivered: boolean; suspicious: boolean }

export async function handleSignal(
  rawBody: string,
  source: SignalSource,
  auth: { secret?: string; signature?: string },
  deps: AppDeps,
): Promise<SignalResult> {
  const ing = ingest(rawBody, source, { secret: auth.secret, signature: auth.signature })
  if (!ing.ok) return { ok: false, reason: ing.reason }
  return diagnose(ing.candidate, ing.suspicious, deps)
}

/**
 * The diagnosis core, shared by every ingestion path (our HMAC format, native Sentry, …). Takes an
 * already-verified, normalized candidate and runs aggregate → record → RCA → deliver → log/telemetry.
 */
export async function diagnose(
  c: import('@sho/contracts').IncidentCandidate,
  ingestSuspicious: boolean,
  deps: AppDeps,
): Promise<SignalResult> {
  const classKey = `${moduleArea(c)}::${symptomSignature(c)}`
  const pr = priority(c, { businessCriticality: deps.criticality })
  // AWAIT: the incident row must exist before the notify_state CAS below reads it (durable Pg path).
  await deps.mem.recordIncident({
    id: c.id, fingerprint: fingerprint(c), symptomSignature: classKey.split('::')[1] ?? '',
    moduleArea: moduleArea(c), signalText: `${c.affected_service} ${c.fingerprint}`, firstSeenMs: Date.parse(c.first_seen),
  })

  const evidenceSummary = `occ=${c.occurrences} deploys=${c.recent_deploys.length} shape=${c.shape}`
  const proposal = deps.propose ? await deps.propose({ candidate: c, evidenceSummary }) : undefined
  const tools = fakeTools({ ...(proposal ? { llm: new FakeLlmClient(proposal) } : {}), ...deps.toolOverrides })

  const raw = c.raw_payload as Record<string, unknown> | null
  const telemetryText = [String(raw?.title ?? ''), String(raw?.message ?? '')].filter(Boolean)
  const inv = investigate(c, tools, { telemetryText })

  let delivered = false
  if (await deps.notify.casNotified(c.id)) {
    const payload: DeliveryPayload = {
      incidentId: c.id, hypothesis: inv.trace.hypothesis, correlationState: inv.trace.correlationState,
      gate: inv.gate, recommendedAction: inv.trace.recommendedAction, suspicious: inv.trace.suspiciousContentFlag,
    }
    for (const sink of deps.deliverSinks ?? []) sink(payload)
    delivered = true
  }

  const suspicious = ingestSuspicious || inv.trace.suspiciousContentFlag
  const at = new Date().toISOString()
  deps.oplog?.record({
    incidentId: c.id, classKey, gate: inv.gate, correlationState: inv.trace.correlationState,
    priority: pr, delivered, suspicious, at,
  })
  deps.telemetry?.emit({
    kind: 'rca_outcome', at, classKey, incidentId: c.id,
    data: { gate: inv.gate, correlationState: inv.trace.correlationState, delivered, suspicious, priority: pr },
  })

  return {
    ok: true, incidentId: c.id, classKey, priority: pr, gate: inv.gate,
    correlationState: inv.trace.correlationState, delivered, suspicious,
  }
}
