/**
 * The sandboxed repair worker — the concrete `RepairAuthor` (@sho/loop-c) for a live repo. It is the
 * composition of two deliberately-separated halves so the risky part is isolated and honest:
 *
 *   1. a PROPOSER (repair-claude.ts) — an LLM turns the grounded why-trace + the read file contents into a
 *      candidate {diff, regression test}. Its output is DATA, never executed here; it can be replaced by any
 *      author. Untrusted (D7): parsed defensively, never treated as an instruction.
 *   2. a SANDBOX (repair-sandbox.ts) — applies that diff in an ephemeral git worktree and RUNS the regression
 *      test to observe the two grounded booleans (reproduced-on-parent, flipped-green-on-fix). This half
 *      executes untrusted code and therefore, in production, MUST run inside the hardened, egress-denied,
 *      secret-less container of SECURITY-THREATMODEL §4 — the package cannot provide kernel isolation itself.
 *
 * The author enforces the LOOP-C §4.1 cycle order exactly (reproduce → patch → flip green) and blocks a
 * protected-path or malformed-diff proposal BEFORE any execution. It returns a StagedPatch for the gate, or
 * null when it declines (unparseable proposal, diff won't apply, or the signal did not reproduce). It never
 * applies to production — that is the gate's + the human's job downstream (runRepair / confirmRepair).
 */

import type { RepairAuthor, RepairContext, StagedPatch } from '@sho/loop-c'
import { protectedPathsTouched } from '@sho/loop-c'

/** The read-only files the sandbox hands the proposer (its "code_search / git_read" surface). */
export interface RepoFile {
  path: string
  content: string
}

/** A candidate the proposer authored. Pure data — a unified diff + a regression test — until the sandbox runs it. */
export interface RepairProposal {
  summary: string
  /** unified diff against the base ref (the source fix). */
  diff: string
  /** the regression test that must fail on parent and pass on the fix. */
  testPath: string
  testSource: string
  /** the touched module source file(s) the gate will mutate. */
  sourceFiles: string[]
  /** ALL paths the change writes (diff + test) — the protected-path / diff-policy check operates on this. */
  touchedPaths: string[]
}

/** The proposer port: (why-trace context + read files) → a candidate, or null when it declines. Async (LLM). */
export type RepairProposer = (ctx: RepairContext, files: RepoFile[]) => Promise<RepairProposal | null>

/** One ephemeral sandbox session over a git worktree. Every method operates inside the isolated worktree. */
export interface SandboxSession {
  /** the base commit the worktree is checked out at (StagedPatch.parentSha). */
  readonly baseSha: string
  /** the main repo path the committed fix ref lives in (StagedPatch.repo — survives close()). */
  readonly repo: string
  readFile(path: string): string | null
  writeFile(path: string, content: string): void
  /** git-apply the unified diff; false if it does not apply cleanly (→ the author declines). */
  applyDiff(diff: string): boolean
  /** run the configured test command in the worktree; exitCode 0 = pass. Hard wall-clock timeout. */
  run(): { exitCode: number }
  /** commit the worktree onto the fix branch in the MAIN repo; returns the fix sha (persists after close). */
  commit(message: string): string
  close(): void
}

export interface RepairSandbox {
  /** open a fresh, isolated session (a new worktree + a fix branch). */
  open(ctx: RepairContext): SandboxSession
}

export interface SandboxedRepairAuthorDeps {
  propose: RepairProposer
  sandbox: RepairSandbox
}

/** Compose proposer + sandbox into a RepairAuthor that runs the grounded repro cycle (LOOP-C §4.1). */
export function sandboxedRepairAuthor(deps: SandboxedRepairAuthorDeps): RepairAuthor {
  return {
    async author(ctx: RepairContext): Promise<StagedPatch | null> {
      const s = deps.sandbox.open(ctx)
      try {
        // Read the affected files (the proposer's read-only view) and ask for a candidate.
        const files: RepoFile[] = []
        for (const p of ctx.whyTrace.affectedComponents) {
          const content = s.readFile(p)
          if (content !== null) files.push({ path: p, content })
        }
        const proposal = await deps.propose(ctx, files)
        if (!proposal) return null

        // Defense in depth: block a protected-path write BEFORE any execution (runRepair blocks again).
        if (protectedPathsTouched(proposal.touchedPaths).length > 0) return null

        // §4.1 step 1 — write the regression test, run on PARENT: it must FAIL (the signal reproduces).
        s.writeFile(proposal.testPath, proposal.testSource)
        const onParent = s.run()
        const reproReproducedSignal = onParent.exitCode !== 0

        // §4.1 step 2 — apply the source fix. A malformed diff is a decline, never a crash.
        if (!s.applyDiff(proposal.diff)) return null

        // §4.1 step 3 — commit and run on FIX: it must PASS (the fix flips the repro green).
        const fixSha = s.commit(`sho: ${proposal.summary}`)
        const onFix = s.run()
        const fixFlippedReproGreen = onFix.exitCode === 0

        return {
          summary: proposal.summary,
          repo: s.repo,
          parentSha: s.baseSha,
          fixSha,
          testPaths: [proposal.testPath],
          sourceFiles: proposal.sourceFiles,
          touchedPaths: proposal.touchedPaths,
          reproReproducedSignal,
          fixFlippedReproGreen,
        }
      } finally {
        s.close()
      }
    },
  }
}
