/**
 * The real RunGate for @sho/loop-c — a thin bridge onto the non-LLM verification gate (gate/verify.ts). It
 * hands the staged (parentSha, fixSha) + the class's mutation bar to `verify()` (must-fail-on-parent +
 * mutation score + no-weakening, all driving real git) and maps the rich result down to the shared contracts
 * GateResult that runRepair and the auto_action landing store. The gate is causally INDEPENDENT of the model
 * that authored the fix (D8) — that independence is why it can catch a confidently-wrong repair.
 */

import type { GateResult, GateSignals } from '@sho/contracts'
import type { RepairContext, RunGate, StagedPatch } from '@sho/loop-c'
import { verify, type GateResult as RichGateResult } from '../../../gate/verify'

/** Pure map: gate/verify.ts's rich result → the contracts GateResult (loop C, the resolved tier). */
export function toContractsGate(rich: RichGateResult, ctx: Pick<RepairContext, 'moduleArea' | 'autonomy'>): GateResult {
  const s = rich.signals
  return {
    pass: rich.pass,
    moduleArea: rich.context.moduleArea || ctx.moduleArea,
    loop: 'C',
    tier: ctx.autonomy.tier,
    signals: {
      mustFailOnParent: { pass: s.mustFailOnParent.pass, code: s.mustFailOnParent.code as GateSignals['mustFailOnParent']['code'] },
      mutationScore: { pass: s.mutationScore.pass, score: s.mutationScore.score, threshold: s.mutationScore.threshold },
      noWeakening: s.noWeakening ? { pass: s.noWeakening.pass } : null,
      diffLines: s.diffLines,
      exceedsClassBudget: s.exceedsClassBudget,
    },
    reason: rich.reason,
  }
}

export interface VerifyGateOptions {
  /** the test command verify() runs for must-fail-on-parent + mutation (per the gate's runner contract). */
  testCmd: string
  /** the class diff budget (a churn SIGNAL, not a hard gate). Default 15. */
  classDiffBudget?: number
}

/** Build a RunGate that drives the real verification gate over the staged refs. */
export function makeVerifyGate(opts: VerifyGateOptions): RunGate {
  const isTest = (p: string) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(p)
  return async (staged: StagedPatch, ctx: RepairContext): Promise<GateResult> => {
    // every touched test file that isn't the declared new test → checked for no-weakening (an edited existing test).
    const weakenAlsoPaths = staged.touchedPaths.filter((p) => isTest(p) && !staged.testPaths.includes(p))
    const rich = verify({
      repo: staged.repo,
      parentRef: staged.parentSha,
      fixRef: staged.fixSha,
      testPaths: staged.testPaths,
      weakenAlsoPaths,
      sourceFiles: staged.sourceFiles,
      testCmd: opts.testCmd,
      requiredMutationScore: ctx.autonomy.requiredMutationScore,
      classDiffBudget: opts.classDiffBudget,
      moduleArea: ctx.moduleArea,
      loop: 'C',
      tier: ctx.autonomy.tier,
    })
    return toContractsGate(rich, ctx)
  }
}
