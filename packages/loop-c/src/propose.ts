/**
 * The PROPOSE path (LOOP-C-DEFERRED.md §4 grounded repro cycle + §5.1 L1 PR). It authors a candidate,
 * runs the mandatory grounded checks and the non-LLM gate, and — only if the gate PASSES — opens a PR,
 * enqueues an L1 approval, and notifies. It writes NO landing: a landing exists only after a human confirms
 * (see confirm.ts). Ordered so a bad fix is stopped at the earliest possible gate and never reaches a human:
 *
 *   trigger guard → autonomy floor → author → protected-path block → grounded-repro block → GATE → propose
 *
 * The human therefore only ever reviews a diff that already reproduced the bug, flipped it green, and cleared
 * must-fail-on-parent + mutation + no-weakening. That is what makes L1 confirmation a real review, not a rubber stamp.
 */

import type { TelemetrySink } from '@sho/contracts'
import type { ApprovalQueue } from '@sho/hitl'
import type {
  RepairAuthor,
  ChangeRequestPublisher,
  RunGate,
  RepairContext,
  RepairOutcome,
  StagedPatch,
} from './types'
import { protectedPathsTouched } from './protected'
import type { GateResult } from '@sho/contracts'

export interface ProposeDeps {
  author: RepairAuthor
  runGate: RunGate
  publisher: ChangeRequestPublisher
  approvals: ApprovalQueue
  nowMs: number
  /** id factory for the approval_request (default crypto.randomUUID). Injected for deterministic tests. */
  newApprovalId?: () => string
  /** best-effort out-of-band notice (Telegram deep-link to the PR). Never the source of truth. */
  notify?: (o: RepairOutcome) => void | Promise<void>
  telemetry?: TelemetrySink
}

export async function runRepair(ctx: RepairContext, deps: ProposeDeps): Promise<RepairOutcome> {
  const iid = ctx.incidentId

  // 1. TRIGGER GUARD — only a grounded CONFIRMED *code* diagnosis is eligible (§4 input; §6 sends the rest
  //    — config/data/capacity/architectural/security — to a human as a Loop A trace forever).
  if (ctx.loopADecision !== 'CONFIRMED' || ctx.whyTrace.fixClass !== 'code') {
    return { incidentId: iid, status: 'skipped_not_confirmed', reason: `not an actionable code fix (decision=${ctx.loopADecision}, fixClass=${ctx.whyTrace.fixClass})` }
  }

  // 2. AUTONOMY FLOOR — L0 is kill-switch / churn-hold / diagnosis-only (§7). No write is even authored.
  if (ctx.autonomy.level === 'L0') {
    return { incidentId: iid, status: 'skipped_killed', reason: 'autonomy L0 — diagnosis only (kill switch or churn hold engaged)' }
  }

  // 3. AUTHOR + STAGE the candidate in the sandbox (§3 workers, §4.1 steps 1–3). null = declined.
  const staged = await deps.author.author(ctx)
  if (!staged) {
    return { incidentId: iid, status: 'declined_by_author', reason: 'repair worker declined — signal did not reproduce or class is out of code-repair scope (Loop A forever, §6)' }
  }

  // 4. PROTECTED-PATH HARD BLOCK (§5.3) — never gate/propose a Tier-4 write; there is no earn-path out.
  const protectedHits = protectedPathsTouched(staged.touchedPaths)
  if (protectedHits.length > 0) {
    return { incidentId: iid, status: 'blocked_protected_path', reason: `touches protected path(s): ${protectedHits.join(', ')} — never autonomous at any level (§5.3)`, staged }
  }

  // 5. GROUNDED-REPRO INVARIANT (§4.1) — a fix that did not reproduce the signal AND flip it green is not
  //    grounded (D3). It never reaches the gate. This is also the anti-spoof backstop (§4.3).
  if (!staged.reproReproducedSignal || !staged.fixFlippedReproGreen) {
    return { incidentId: iid, status: 'blocked_ungrounded_repro', reason: `ungrounded repro: reproduced=${staged.reproReproducedSignal}, flipped-green=${staged.fixFlippedReproGreen} — not a grounded fix (§4.1)`, staged }
  }

  // 5b. OPERATOR GATE CHECKS — the local dev gates wired in as hooks (typecheck/lint/security/doc-sync/commit-lint).
  //     A failing check escalates with partial work; a fix that doesn't typecheck or trips a security scan never
  //     reaches a human as ready. Cheaper than the mutation gate, so it runs first.
  const failedChecks = staged.checks.filter((c) => !c.passed)
  if (failedChecks.length > 0) {
    return { incidentId: iid, status: 'escalated_failed_check', reason: `gate checks failed: ${failedChecks.map((c) => c.name).join(', ')} — escalated with partial work`, staged }
  }

  // 6. GATE — the non-LLM battery (VERIFICATION-GATE). Causally independent of the model that wrote the fix.
  const gate = await deps.runGate(staged, ctx)
  await deps.telemetry?.emit({
    kind: 'gate_result', at: new Date(deps.nowMs).toISOString(), classKey: ctx.classKey, incidentId: iid,
    data: { pass: gate.pass, loop: 'C', tier: ctx.autonomy.tier, level: ctx.autonomy.level, reason: gate.reason },
  })
  if (!gate.pass) {
    // §4 EXHAUSTED: stop and escalate with the PARTIAL work (best diff + failing gate signals). Never a
    // rubber-stampable PR — a rejected fix is handed to a human as an L1 diagnosis, not surfaced as ready.
    return { incidentId: iid, status: 'escalated_gate_reject', reason: `gate REJECTED — ${gate.reason}; escalated to human with partial work`, gate, staged }
  }

  // 7. PROPOSE (never apply). Open the PR (source of truth), enqueue the L1 approval, notify (deep-link).
  //    NO auto_action row is written here — a landing exists only after a human confirms (confirm.ts).
  const approvalId = (deps.newApprovalId ?? (() => crypto.randomUUID()))()
  const changeRequest = await deps.publisher.publish({
    incidentId: iid,
    classKey: ctx.classKey,
    title: staged.commitSubject, // Conventional Commits subject, e.g. "fix(checkout): guard null cart"
    body: prBody(ctx, staged, gate),
    headSha: staged.fixSha,
    baseSha: staged.parentSha,
  })
  deps.approvals.enqueue(
    {
      id: approvalId,
      incidentId: iid,
      classKey: ctx.classKey,
      loop: 'C',
      tier: 2, // L1 → tier 2 (crosswalk): propose, human merges. Crosswalk-legal for loop C.
      requestedLevel: 1,
      whyTraceId: ctx.whyTrace.incidentId,
      team: ctx.team,
      primaryApprover: ctx.primaryApprover,
      secondaryApprover: ctx.secondaryApprover,
      fixSha: staged.fixSha,
      parentSha: staged.parentSha,
      telegramMsgRef: changeRequest.url,
    },
    deps.nowMs,
  )
  const outcome: RepairOutcome = {
    incidentId: iid,
    status: 'proposed',
    reason: `proposed as PR ${changeRequest.url} — awaiting human confirmation (L1, never auto-applied)`,
    approvalId,
    changeRequest,
    gate,
    staged,
  }
  await deps.notify?.(outcome)
  return outcome
}

/** The PR body a human reviews: the grounded evidence, the gate verdict, and the "merge = approval" contract. */
function prBody(ctx: RepairContext, staged: StagedPatch, gate: GateResult): string {
  const s = gate.signals
  return [
    '### Proposed automatically by SHO Loop C — L1 (propose only, human-merged)',
    '',
    `**Incident:** \`${ctx.incidentId}\`  •  **Class:** \`${ctx.classKey}\`  •  **Module:** \`${ctx.moduleArea}\``,
    `**Grounded hypothesis:** ${ctx.whyTrace.hypothesis}`,
    '',
    `**What & why:** ${staged.summary}`,
    '',
    `**Grounded repro (observed booleans, not self-report):** reproduced=${staged.reproReproducedSignal}, flipped-green=${staged.fixFlippedReproGreen}`,
    '',
    `**Verification gate:** ${gate.pass ? 'PASS ✅' : 'REJECT ❌'} — ${gate.reason}`,
    `- must-fail-on-parent: ${s.mustFailOnParent.pass ? 'pass' : 'fail'} (${s.mustFailOnParent.code})`,
    `- mutation score: ${s.mutationScore.score ?? 'n/a'} ≥ ${s.mutationScore.threshold} → ${s.mutationScore.pass ? 'pass' : 'fail'}`,
    `- no-weakening: ${s.noWeakening ? (s.noWeakening.pass ? 'pass' : 'fail') : 'n/a (new test)'}`,
    `- diff lines: ${s.diffLines}${s.exceedsClassBudget ? ' (exceeds class budget → churn signal)' : ''}`,
    ...(staged.checks.length > 0
      ? ['', `**Operator checks:** ${staged.checks.map((c) => `${c.name} ${c.passed ? '✅' : '❌'}`).join(' · ')}`]
      : []),
    '',
    '**Reviewer checklist**',
    '- [ ] Root cause is right, not just the symptom silenced',
    '- [ ] Docs / CHANGELOG updated if this changes documented behavior',
    '- [ ] No unintended blast radius beyond the cited module',
    '',
    '> **Merging this PR is the approval.** On merge, SHO records a `human_approved` landing (loop C). The',
    '> accountable owner is the trust-class owner (D9); the merging identity is descriptive audit only (§4.3).',
    '> This fix was **never auto-applied** — reject it by closing the PR.',
  ].join('\n')
}
