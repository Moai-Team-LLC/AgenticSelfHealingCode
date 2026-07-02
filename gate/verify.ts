/**
 * Verification Gate — integrated entrypoint (VERIFICATION-GATE.md).
 *
 * Composes the two non-LLM kernels into the single GateResult the router hands downstream:
 *   - must-fail-on-parent (../verification-gate) — the test discriminates (attack #4).
 *   - mutation score       (../mutation-gate)     — the suite is strong enough (D4, Principle 6).
 *   - no-weakening         (../verification-gate) — a heal did not loosen a guard.
 * Plus reported signals: diffLines, moduleArea, exceedsClassBudget (a SIGNAL for the Trust
 * Controller's churn escalator — not a hard gate here; VERIFICATION-GATE.md §5, ARCHITECTURE-REFRAMED §2).
 *
 * pass = mustFail.pass AND mutation.pass AND (noWeakening?.pass ?? true). The gate reports; it does
 * not move tiers (split-brain avoidance). combineGate() is pure and unit-tested; verify() drives git.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateChange, linkNodeModules, git as _git } from '../verification-gate/git-runner'
import { noWeakening, type GateVerdict } from '../verification-gate/gate'
import { runMutationGate } from '../mutation-gate/runner'
import { scoreGate, type ScoreReport, type MutantResult } from '../mutation-gate/gate'

export interface GateResult {
  pass: boolean
  context: { loop?: string; tier?: number; moduleArea: string }
  signals: {
    mustFailOnParent: { pass: boolean; code: string; reason: string }
    mutationScore: { pass: boolean; score: number | null; threshold: number; killed: number; total: number; survivors: { line: number; op: string }[] }
    noWeakening: { pass: boolean; reason: string } | null
    diffLines: number
    exceedsClassBudget: boolean
  }
  reason: string
}

// ---- pure combination -----------------------------------------------------

export function combineGate(input: {
  mustFail: GateVerdict
  mutation: ScoreReport
  noWeakening: { pass: boolean; reason: string } | null
  diffLines: number
  classDiffBudget: number
  moduleArea: string
  loop?: string
  tier?: number
}): GateResult {
  const exceedsClassBudget = input.diffLines > input.classDiffBudget
  const pass = input.mustFail.pass && input.mutation.pass && (input.noWeakening?.pass ?? true)
  const fails: string[] = []
  if (!input.mustFail.pass) fails.push(`must-fail-on-parent (${input.mustFail.code})`)
  if (!input.mutation.pass) fails.push(`mutation score ${input.mutation.score?.toFixed(2) ?? 'n/a'}<${input.mutation.threshold}`)
  if (input.noWeakening && !input.noWeakening.pass) fails.push('no-weakening')
  const reason = pass
    ? `PASS — all hard gates green${exceedsClassBudget ? ' (note: exceeds class diff budget → churn signal for the controller)' : ''}`
    : `REJECT — ${fails.join('; ')}`
  return {
    pass,
    context: { loop: input.loop, tier: input.tier, moduleArea: input.moduleArea },
    signals: {
      mustFailOnParent: { pass: input.mustFail.pass, code: input.mustFail.code, reason: input.mustFail.reason },
      mutationScore: {
        pass: input.mutation.pass, score: input.mutation.score, threshold: input.mutation.threshold,
        killed: input.mutation.killed, total: input.mutation.total, survivors: input.mutation.survivors,
      },
      noWeakening: input.noWeakening,
      diffLines: input.diffLines,
      exceedsClassBudget,
    },
    reason,
  }
}

export function mergeReports(reports: ScoreReport[], threshold: number): ScoreReport {
  const flat: MutantResult[] = []
  let id = 0
  for (const r of reports) {
    for (let k = 0; k < r.killed; k++) flat.push({ id: id++, line: 0, op: '', status: 'killed' })
    for (const s of r.survivors) flat.push({ id: id++, line: s.line, op: s.op, status: 'survived' })
  }
  return scoreGate(flat, threshold)
}

// ---- git drivers ----------------------------------------------------------

function gitOut(repo: string, args: string[]): string {
  // stderr ignored: a missing path on a ref (new test not present on parent) is an expected miss.
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

function diffLines(repo: string, parentRef: string, fixRef: string): number {
  const out = gitOut(repo, ['diff', '--numstat', parentRef, fixRef])
  let total = 0
  for (const l of out.split('\n')) {
    const [add, del] = l.split('\t')
    if (add === undefined || add === '-') continue
    total += (Number(add) || 0) + (Number(del) || 0)
  }
  return total
}

function fileAtRef(repo: string, ref: string, path: string): string | undefined {
  try { return gitOut(repo, ['show', `${ref}:${path}`]) } catch { return undefined }
}

function mutationOnRef(repo: string, ref: string, sourceFiles: string[], testCmd: string, threshold: number): ScoreReport {
  const wt = mkdtempSync(join(tmpdir(), 'vgate-mut-'))
  try {
    execFileSync('git', ['-C', repo, 'worktree', 'add', '--detach', '--force', wt, ref], { stdio: 'ignore' })
    linkNodeModules(repo, wt)
    const reports = sourceFiles.map((sf) => runMutationGate({ dir: wt, sourceFile: sf, testCmd, threshold }))
    return mergeReports(reports, threshold)
  } finally {
    execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', wt], { stdio: 'ignore' })
    rmSync(wt, { recursive: true, force: true })
  }
}

/** The router-facing gate call: one (parentRef, fixRef, module) → one GateResult. */
export function verify(opts: {
  repo: string
  parentRef: string
  fixRef: string
  testPaths: string[] // the new/changed test file(s)
  sourceFiles: string[] // the touched module file(s) to mutate
  testCmd: string
  requiredMutationScore: number // the per-class effective bar from the Trust Controller
  classDiffBudget?: number
  moduleArea?: string
  loop?: string
  tier?: number
}): GateResult {
  const mustFail = validateChange({ repo: opts.repo, parentRef: opts.parentRef, fixRef: opts.fixRef, testPaths: opts.testPaths, testCmd: opts.testCmd })
  const mutation = mutationOnRef(opts.repo, opts.fixRef, opts.sourceFiles, opts.testCmd, opts.requiredMutationScore)

  // no-weakening: only for test files that already existed on the parent (an edited heal, not a new test).
  const weak: { pass: boolean; reason: string }[] = []
  for (const tp of opts.testPaths) {
    const before = fileAtRef(opts.repo, opts.parentRef, tp)
    const after = fileAtRef(opts.repo, opts.fixRef, tp)
    if (before !== undefined && after !== undefined) {
      const w = noWeakening(before, after)
      weak.push({ pass: w.pass, reason: `${tp}: ${w.reason}` })
    }
  }
  const noWeak = weak.length === 0 ? null : { pass: weak.every((w) => w.pass), reason: weak.map((w) => w.reason).join(' | ') }

  const moduleArea = opts.moduleArea ?? opts.sourceFiles[0].split('/').slice(0, 2).join('/')
  return combineGate({
    mustFail, mutation, noWeakening: noWeak,
    diffLines: diffLines(opts.repo, opts.parentRef, opts.fixRef),
    classDiffBudget: opts.classDiffBudget ?? 15,
    moduleArea, loop: opts.loop, tier: opts.tier,
  })
}

export { _git }
