/**
 * @sho/loop-c — HUMAN-CONFIRMED production-code repair (LOOP-C-DEFERRED.md §5.1: "v1 (and every
 * not-yet-earned class): L1 PR for HITL, NEVER auto-merged"). This is the ONE Loop C rung that ships:
 * an agent proposes a fix, the non-LLM gate validates it BEFORE any human sees it, a human confirms via
 * PR merge OR Telegram, and the apply-time writer records a `human_approved` landing. It NEVER auto-applies.
 *
 * What stays deferred is L2/L3 (auto-apply, no human in the loop) — earned per-class on outcome data by the
 * Trust Controller (D6). `effectiveLevel` already returns L1 as the base ("nothing is auto by default"), so
 * this package caps every path at propose-and-confirm; it does not implement an auto-apply write.
 *
 * Loop C owns no new machinery — it composes the gate (VERIFICATION-GATE), the approval ladder (@sho/hitl),
 * and the apply-time writer (@sho/orchestrator). This file is only the contract spine for that composition.
 */

import type { WhyTrace, GateResult, Tier, AutonomyLevel } from '@sho/contracts'

/**
 * The resolved autonomy tuple the ORCHESTRATION router hands Loop C (LOOP-C §5.4). Loop C NEVER derives
 * its own tier or mutation bar — it consumes what the Trust Controller resolved for the class.
 */
export interface ResolvedAutonomy {
  level: AutonomyLevel // L0 → diagnosis only (kill switch / churn hold); L1+ → propose (we cap at propose)
  tier: Tier // crosswalk(level): L1 → 2
  requiredMutationScore: number // the per-class effective mutation bar handed to the gate
  accountableOwner: string | null // = trust_class.owner (D9); null blocks a landing
}

/** The trigger for a repair attempt: a grounded CONFIRMED code diagnosis + the resolved autonomy tuple. */
export interface RepairContext {
  incidentId: string
  classKey: string // (module_area, symptom_signature) — ARCHITECTURE-REFRAMED §6
  moduleArea: string
  team: string
  primaryApprover: string | null
  secondaryApprover: string | null
  whyTrace: WhyTrace // Loop A's grounded output (LOOP-A-SPEC)
  loopADecision: 'CONFIRMED' | 'ESCALATE' // only CONFIRMED is eligible (§4 input)
  autonomy: ResolvedAutonomy
}

/**
 * A candidate patch a repair worker AUTHORED and STAGED in the sandbox, ready for the gate (§4 steps 1–3).
 * The two grounded booleans are observed facts from the sandbox repro cycle — never an LLM self-report (D3).
 */
export interface StagedPatch {
  summary: string // human-readable what & why (PR body)
  commitSubject: string // Conventional Commits first line, e.g. "fix(checkout): guard null cart"
  repo: string // sandbox repo path the gate drives
  parentSha: string
  fixSha: string
  testPaths: string[] // regression test file(s) — must-fail-on-parent (§4 S4)
  sourceFiles: string[] // touched module file(s) to mutate (§4 S5)
  touchedPaths: string[] // ALL paths the diff writes (protected-path check, §5.3)
  reproReproducedSignal: boolean // §4.1 step 1: the signal reproduced against real repo state
  fixFlippedReproGreen: boolean // §4.1 step 3: the fix flipped the regression test green
  /** results of the operator-configured extra gate checks (lint/typecheck/security/doc-sync/commit-lint). */
  checks: RepairCheckResult[]
}

/** One extra gate check run in the sandbox — the operator's own local dev gates wired in as hooks. */
export interface RepairCheckResult {
  name: string
  passed: boolean
}

/**
 * PORT — the repair worker (the "brain"). Real implementation is Claude + a git worktree sandbox (async,
 * kept OUTSIDE this pure orchestration, exactly like loop-a's `proposeWithClaude`). Returns null when the
 * worker declines: the signal did not reproduce, or the class is out of code-repair scope (Loop A forever, §6).
 */
export interface RepairAuthor {
  author(ctx: RepairContext): Promise<StagedPatch | null>
}

/** PORT — publish the validated fix as a human change request (a GitHub PR). Real = GitHub API (injected fetch). */
export interface ChangeRequestInput {
  incidentId: string
  classKey: string
  title: string
  body: string // summary + gate signals + the "merge = approval" note
  headSha: string
  baseSha: string
}
export interface PublishedChangeRequest {
  url: string
  number: number
  headSha: string // the sha a merge webhook will report — the idempotency anchor for confirmRepair
}
export interface ChangeRequestPublisher {
  publish(input: ChangeRequestInput): Promise<PublishedChangeRequest>
}

/** Injected gate runner — wraps gate/verify.ts down to the contracts GateResult. Fake returns a canned result. */
export type RunGate = (staged: StagedPatch, ctx: RepairContext) => Promise<GateResult>

/** Why a repair attempt ended. Only `proposed` reaches a human; nothing here ever auto-applies. */
export type RepairStatus =
  | 'skipped_not_confirmed' // not a grounded CONFIRMED code diagnosis
  | 'skipped_killed' // autonomy L0 — diagnosis only
  | 'declined_by_author' // the worker declined (unreproducible / out of scope)
  | 'blocked_protected_path' // touched auth/billing/infra/migrations/CI — never autonomous (§5.3)
  | 'blocked_ungrounded_repro' // repro/flip booleans false — never grounded, never gated (§4.1)
  | 'escalated_failed_check' // an operator gate check (lint/typecheck/security/doc-sync) failed — escalate
  | 'escalated_gate_reject' // gate REJECTED — escalate with partial work, never surfaced as ready
  | 'proposed' // gate PASSED — PR opened, L1 approval enqueued, human notified

export interface RepairOutcome {
  status: RepairStatus
  reason: string
  incidentId: string
  approvalId?: string
  changeRequest?: PublishedChangeRequest
  gate?: GateResult
  staged?: StagedPatch
}
