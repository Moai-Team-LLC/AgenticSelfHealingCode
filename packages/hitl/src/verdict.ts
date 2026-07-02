/**
 * §4.2 — THE BUTTON → VERDICT CONTRACT (anti-rubber-stamp).
 *
 * A button tap EMITS a provisional human-verdict event; it never writes a durable POSITIVE outcome label.
 * Ownership is split cleanly (§0, addendum #4):
 *   - this layer EMITS the verdict event;
 *   - INCIDENT-MEMORY.md §5 PERSISTS the label onto `resolutions` (it owns that table + freeze trigger);
 *   - ORCHESTRATION.md §5 INSERTS any `auto_action` row.
 *
 * The pivotal invariants this module encodes:
 *   1. Approve on a Loop A hand-off → OutcomeLabel 'provisional_human_confirmed' (NOT 'confirmed_good' —
 *      promotion still needs the outcome-watcher window, keystone §3.5). A weak, controller-neutral state.
 *   2. Reject → 'wrong_rca' (an anti-pattern label; feeds the contraction breaker only, never expansion).
 *   3. `accountable_owner` STAYS `trust_class.owner` (D9, addendum #1). The tapping/editing human is
 *      recorded only in the DESCRIPTIVE `verdict_by` / `merged_by` fields — never the owner of record.
 *   4. No tap moves the class's autonomy level (that is outcome-driven, owned by the Trust Controller).
 */

import type { OutcomeLabel } from '@sho/contracts'

export type Button = 'approve' | 'reject' | 'edit'

/** Which surface the tap acted on: a Loop A diagnosis hand-off, or a Loop B/C change approval. */
export type VerdictSurface = 'loopA_handoff' | 'loopBC_approval'

/** The verdict event this layer EMITS. Incident Memory persists the label; this is the wire shape. */
export interface VerdictEvent {
  incidentId: string
  whyTraceId: string
  surface: VerdictSurface
  button: Button
  /** DESCRIPTIVE audit identity of who acted (§4.4) — NEVER the accountability owner. */
  verdictBy: string
  atMs: number
  /** For a Loop A hand-off: the OutcomeLabel Incident Memory should persist. Null for a Loop B/C approve —
   *  that path sets approval_request.state=APPROVED and lets the outcome verdict stay 'pending'. */
  emitLabel: OutcomeLabel | null
  /** For a Loop B/C approve: the apply-time writer should insert the auto_action row (ORCH §5). */
  triggersApplyTimeWrite: boolean
  /** For a Loop B/C reject: feeds override telemetry + the N_reject contraction breaker only. */
  feedsContractionBreaker: boolean
}

export interface VerdictInput {
  incidentId: string
  whyTraceId: string
  surface: VerdictSurface
  button: Button
  verdictBy: string
  atMs: number
  /** For an edit on a Loop B/C approval: the edited change of record (§4.3). */
  editedFixSha?: string
}

/**
 * Resolve a button tap into the verdict event to emit. Pure — no writes, no autonomy change. The caller
 * hands the event to Incident Memory (label) and/or the orchestrator (apply-time write / resume).
 */
export function resolveVerdict(input: VerdictInput): VerdictEvent {
  const base = {
    incidentId: input.incidentId,
    whyTraceId: input.whyTraceId,
    surface: input.surface,
    button: input.button,
    verdictBy: input.verdictBy,
    atMs: input.atMs,
  }

  if (input.surface === 'loopA_handoff') {
    // Loop A never authors a change → no Edit; Approve/Reject only.
    if (input.button === 'edit') {
      throw new Error('Loop A hand-off has no Edit — it authors no change (§4.2)')
    }
    const emitLabel: OutcomeLabel = input.button === 'approve' ? 'provisional_human_confirmed' : 'wrong_rca'
    return { ...base, emitLabel, triggersApplyTimeWrite: false, feedsContractionBreaker: false }
  }

  // Loop B/C approval surface.
  switch (input.button) {
    case 'approve':
    case 'edit':
      // Approve or Edit → state APPROVED; orchestrator RESUMEs into the apply-time writer. The outcome
      // verdict for that actionId stays 'pending' (weight 0) until the watcher matures it — NO label here.
      return { ...base, emitLabel: null, triggersApplyTimeWrite: true, feedsContractionBreaker: false }
    case 'reject':
      // No write; feeds override telemetry + the N_reject contraction breaker (contract only, never expand).
      return { ...base, emitLabel: null, triggersApplyTimeWrite: false, feedsContractionBreaker: true }
  }
}

/**
 * The accountability owner of record for a landed change is ALWAYS `trust_class.owner` (D9, addendum #1),
 * regardless of who tapped Approve or edited the diff. This helper makes the invariant callable/testable:
 * the approver is descriptive; the owner is the class owner, full stop.
 */
export function accountableOwner(trustClassOwner: string, _approverIdentity: string): string {
  return trustClassOwner
}
