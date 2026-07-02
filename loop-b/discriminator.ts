/**
 * Loop B — the A/B/C/D discriminator (LOOP-B-SPEC.md "Discriminator (decision procedure)").
 *
 * A test goes red after a code change. Classify it, because the action differs wildly by class and a
 * wrong "heal" has temporally-unbounded blast radius (a loosened guard protects every future change):
 *
 *   A_regression      — the change broke real behavior. Leave red, alert. NEVER auto-edit the test.
 *   B_stale_candidate — the change deliberately changed behavior; the test encodes the old expectation.
 *                       Ambiguous with A → hand to the change's AUTHOR at PR time (the intent oracle).
 *   C_flaky           — non-deterministic. Auto-quarantine (the ONE autonomous action).
 *   D_infra           — didn't run (compile/import/fixture). Route to build-fix, not healing.
 *
 * Only C is autonomous. Healing (B) is never autonomous — it is a PR-time author-assist. This module
 * is the pure decision; ./signals.ts computes the inputs and ./analyze.ts drives git/test runs.
 */

export type BrokenClass = 'A_regression' | 'B_stale_candidate' | 'C_flaky' | 'D_infra'

export interface BrokenSignals {
  ran: boolean // false → the test never executed (compile/import/fixture error)
  flaky: boolean // re-runs on unchanged code disagree
  failureMode: 'crash' | 'assertion' // threw/timed-out vs a clean expected-vs-actual mismatch
  coversOutsideDiff: boolean // the failing test exercises code the change did NOT touch
}

export interface Decision {
  cls: BrokenClass
  autonomous: boolean
  action: string
  reason: string
}

/** Steps 1–5 of the spec, in order. The order matters: flakiness must be ruled out before a red is
 *  ever read as a regression, and a crash / out-of-diff break is a regression before it is ever a
 *  heal candidate. */
export function classify(s: BrokenSignals): Decision {
  // Step 1 — did it even run?
  if (!s.ran) {
    return { cls: 'D_infra', autonomous: false, action: 'route to build-fix (compile/import/fixture)', reason: 'test did not execute — broken infra, not a behavior signal' }
  }
  // Step 2 — non-determinism before anything else, or flakiness masquerades as a regression.
  if (s.flaky) {
    return { cls: 'C_flaky', autonomous: true, action: 'auto-quarantine: skip-tag + low-priority PR with re-run evidence', reason: 'inconsistent pass/fail on unchanged code — non-deterministic' }
  }
  // Step 3 — a crash is (almost) never a stale test.
  if (s.failureMode === 'crash') {
    return { cls: 'A_regression', autonomous: false, action: 'leave red, alert human — NEVER heal', reason: 'failed by throw/timeout, not a value assertion — a crash is not a stale expectation' }
  }
  // Step 4 — a break in code the change did not touch is a side-effect regression.
  if (s.coversOutsideDiff) {
    return { cls: 'A_regression', autonomous: false, action: 'leave red, alert human — NEVER heal', reason: 'the failing test exercises code outside the change diff — side-effect regression' }
  }
  // Step 5 — clean assertion mismatch on code inside the diff: ambiguous A vs B → the author decides.
  return {
    cls: 'B_stale_candidate',
    autonomous: false,
    action: 'PR-time author prompt: [heal to new behavior] or [this is a regression, I will fix]. If approved, the heal is validated by ../verification-gate (must-fail-on-parent + no-weakening).',
    reason: 'clean assertion mismatch on code inside the change diff — could be an intended behavior change (heal) or a real regression; only the author knows',
  }
}
