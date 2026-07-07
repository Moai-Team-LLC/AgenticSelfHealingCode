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
import { runRepair, type RepairAuthor, type RunGate, type ChangeRequestPublisher, type ResolvedAutonomy, type RepairOutcome, type RepairContext, type LandingStore } from '@sho/loop-c'
import { churnHold } from '@sho/trust-controller'
import type { ApprovalQueue } from '@sho/hitl'
import type { IncidentLog } from './oplog'
import type { RepairIndexStore } from './repairindex'

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
  /** Slack signing secret; the /slack/callback endpoint verifies `x-slack-signature` with it (fail-closed). */
  slackSigningSecret?: string
  /** answer a Telegram callback_query (clears the button spinner). Real: TelegramNotifier. */
  answerCallback?: (callbackQueryId: string, text: string) => void | Promise<void>
  /** Loop C — human-confirmed code repair. When set, a CONFIRMED *code* diagnosis triggers a propose
   *  attempt (author → gate → PR + approval). Absent → diagnosis only (the v1 default). Never auto-applies. */
  repair?: RepairDeps
}

/**
 * The Loop C (human-confirmed repair) wiring. `resolveAutonomy` and `routing` are the seams the ORCHESTRATION
 * router owns in production (Trust Controller effectiveLevel + ownership config); injected here so the trigger
 * is testable. The `author` is the pluggable repair worker (real = a Claude proposer inside the sandbox).
 */
export interface RepairDeps {
  author: RepairAuthor
  runGate: RunGate
  publisher: ChangeRequestPublisher
  approvals: ApprovalQueue
  store: LandingStore // InMemoryAutoActionStore (fakes) or PgAutoActionStore (durable) — both satisfy it
  index: RepairIndexStore // RepairIndex (fakes) or PgRepairIndex (durable — survives a crash before merge)
  /** resolve the autonomy tuple for a class (real: TrustController.effectiveLevel + crosswalk). */
  resolveAutonomy: (classKey: string, moduleArea: string, killed: boolean) => ResolvedAutonomy
  /** team + approvers for a module_area (real: ownership config). */
  routing: (moduleArea: string) => { team: string; primaryApprover: string | null; secondaryApprover: string | null }
  /** out-of-band notice on a proposal (Telegram deep-link to the PR). */
  notify?: (o: RepairOutcome) => void | Promise<void>
  /** secret the GitHub PR-merge webhook (`x-hub-signature-256`) is verified against. */
  githubWebhookSecret?: string
  /** the landing timestamps (ms) for a module_area → the churn escalator (§4.1). Absent → no churn hold.
   *  Real: `(area) => (await store.listByArea(area)).map(a => Date.parse(a.applied_at))`. */
  churnActions?: (moduleArea: string) => number[] | Promise<number[]>
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

  // Loop C — human-confirmed repair (opt-in). A grounded CONFIRMED *code* diagnosis becomes a proposed PR
  // for a human to merge; it NEVER auto-applies. In production this is a durable orchestrator step; here it
  // runs inline behind the flag so the end-to-end path (propose → gate → PR + approval) is testable.
  if (deps.repair && inv.gate === 'CONFIRMED' && inv.trace.fixClass === 'code') {
    await attemptRepair(c, classKey, inv.trace, deps, deps.repair)
  }

  return {
    ok: true, incidentId: c.id, classKey, priority: pr, gate: inv.gate,
    correlationState: inv.trace.correlationState, delivered, suspicious,
  }
}

/** Run one propose attempt and, if it resulted in a PR, record it so both confirm channels can find it. */
async function attemptRepair(
  c: import('@sho/contracts').IncidentCandidate,
  classKey: string,
  trace: WhyTrace,
  deps: AppDeps,
  repair: RepairDeps,
): Promise<void> {
  const area = moduleArea(c)
  const killed = deps.killSwitch ? await deps.killSwitch.isKilled(Date.now()) : false
  // Churn escalator (§4.1): a thrashing area is held from further auto-proposals even at L1 → floor to L0.
  const churnHeld = repair.churnActions ? churnHold(await repair.churnActions(area), Date.now()) : false
  const resolved = repair.resolveAutonomy(classKey, area, killed)
  const autonomy: ResolvedAutonomy = churnHeld ? { ...resolved, level: 'L0', tier: 1 } : resolved
  const route = repair.routing(area)
  const ctx: RepairContext = {
    incidentId: c.id, classKey, moduleArea: area,
    team: route.team, primaryApprover: route.primaryApprover, secondaryApprover: route.secondaryApprover,
    whyTrace: trace, loopADecision: 'CONFIRMED', autonomy,
  }
  const outcome = await runRepair(ctx, {
    author: repair.author, runGate: repair.runGate, publisher: repair.publisher,
    approvals: repair.approvals, nowMs: Date.now(), notify: repair.notify, telemetry: deps.telemetry,
  })
  if (outcome.status === 'proposed' && outcome.approvalId && outcome.changeRequest && outcome.staged && outcome.gate) {
    await repair.index.record({
      approvalId: outcome.approvalId, incidentId: c.id, classKey, moduleArea: area,
      parentSha: outcome.staged.parentSha, fixSha: outcome.staged.fixSha,
      prNumber: outcome.changeRequest.number, prUrl: outcome.changeRequest.url,
      accountableOwner: autonomy.accountableOwner ?? route.team, // L1 fallback: team owns if class owner unset
      gateResult: outcome.gate,
    })
  }
}
