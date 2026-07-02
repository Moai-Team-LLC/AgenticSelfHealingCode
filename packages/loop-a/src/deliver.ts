/**
 * Race-safe delivery (LOOP-A-SPEC §8, attack #9). Loop A never acts, so there is nothing to collide with a
 * human's rollback — but it must not spam a resolved incident or double-notify. Delivery is a single
 * durable compare-and-set on the incident's notify_state: the payload is sent IFF this call performs
 * investigating→notified atomically (single writer). On a lost race (the human already resolved and the CAS
 * is taken), we do NOT re-deliver — we persist the COMPLETE why-trace so a later re-alert is not blind.
 *
 * The CAS and the trace sink are injected (in prod: orchestrator NotifyStore + Incident Memory). The
 * default fakes make this testable NOW with no Telegram, no network.
 */

import type { WhyTrace } from '@sho/contracts'

/** The durable notify CAS: returns true IFF THIS call performed investigating→notified (§8, §5 CAS). */
export interface NotifyCas {
  casNotified(incidentId: string): boolean
}

/** Where a delivered payload goes (Telegram HITL bot in prod). Injected; fake records calls. */
export interface PayloadSink {
  send(incidentId: string, payload: string): void
}

/** Where the complete why-trace is persisted (Incident Memory in prod). Injected. */
export interface TraceSink {
  persist(trace: WhyTrace): void
}

export type DeliveryOutcome =
  | { delivered: true; persisted: true } // we won the CAS: sent the payload AND persisted the trace
  | { delivered: false; persisted: true; reason: 'lost_race' } // human already resolved: trace persisted, no send
  | { delivered: false; persisted: true; reason: 'already_notified' } // idempotent re-call: no double-send

/**
 * Deliver a completed why-trace race-safely.
 *
 * - The trace is ALWAYS persisted (complete, not partial) — even when the human wins the race — so a
 *   subsequent re-alert on the same fingerprint is not blind, and a wrong human action still has the
 *   correct RCA on record (§8).
 * - The payload is sent IFF the CAS transition wins. A second call for the same incident is a no-op send
 *   (idempotent, no double-notify) but still persists (persist is itself idempotent at the sink).
 */
export function deliver(trace: WhyTrace, cas: NotifyCas, sinks: { payload: PayloadSink; trace: TraceSink }): DeliveryOutcome {
  // Persist first: the complete trace must survive regardless of who wins the race (§8 supersede path).
  sinks.trace.persist(trace)

  const won = cas.casNotified(trace.incidentId)
  if (!won) {
    // The CAS was already taken — either a prior delivery (idempotent re-call) or the human resolved and
    // the orchestrator flipped notify_state. Either way: do NOT re-deliver. Trace is on record.
    return { delivered: false, persisted: true, reason: 'lost_race' }
  }

  sinks.payload.send(trace.incidentId, renderPayload(trace))
  return { delivered: true, persisted: true }
}

/**
 * Render the compressed, human-facing enriched-incident payload (§7). Confidence booleans, NOT a number,
 * so a thin RCA is visibly thin. The suspicious-content warning rides on THIS message (the one decision
 * surface), never only in the deep-linked trace (D7).
 */
export function renderPayload(trace: WhyTrace): string {
  const g = trace.confidence
  const check = (b: boolean | null, label: string): string =>
    b === true ? `  ✅ ${label}` : b === false ? `  ❌ ${label}` : `  — ${label} (n/a)`
  const lines = [
    `🔴 ${trace.affectedComponents[0] ?? trace.incidentId}`,
    ``,
    `WHY`,
    trace.hypothesis,
    ``,
    `GROUNDED CHECKS`,
    check(g.reproduced, 'reproduced in sandbox'),
    check(g.explainsAllOccurrences, 'explains sampled occurrences (G2)'),
    check(g.affectedPathInDeployDiff, 'implicated path in deploy diff (G3)'),
    check(g.stepVsSlopeConsistent, 'step-change at deploy (G6)'),
    ``,
    trace.suspiciousContentFlag
      ? `⚠️ SUSPICIOUS CONTENT IN LOGS — treat this cause with caution; a log line contained instruction-like text (quoted in the trace)`
      : `⚠️ SUSPICIOUS CONTENT IN LOGS — none detected`,
    ``,
    `RECOMMENDED NEXT STEP`,
    `  → ${trace.recommendedAction}`,
  ]
  return lines.join('\n')
}

// ── in-memory fakes (default sinks/CAS so delivery is testable without infra) ────────────────────────

/** Fake CAS matching the orchestrator NotifyStore semantics: first call wins, rest are no-ops. */
export class FakeNotifyCas implements NotifyCas {
  private readonly notified = new Set<string>()
  casNotified(incidentId: string): boolean {
    if (this.notified.has(incidentId)) return false
    this.notified.add(incidentId)
    return true
  }
  /** Pre-mark an incident as already notified/resolved — simulates the human winning the race. */
  markNotified(incidentId: string): void {
    this.notified.add(incidentId)
  }
}

export class FakePayloadSink implements PayloadSink {
  readonly sent: { incidentId: string; payload: string }[] = []
  send(incidentId: string, payload: string): void {
    this.sent.push({ incidentId, payload })
  }
}

export class FakeTraceSink implements TraceSink {
  readonly persisted: WhyTrace[] = []
  persist(trace: WhyTrace): void {
    this.persisted.push(trace)
  }
}
