/**
 * Git/test-runner driver for the Verification Gate kernel (gate.ts).
 *
 * The subtle, load-bearing part of must-fail-on-parent: a fix commit usually adds the fix AND its
 * regression test together, so the parent commit has no such test. To honestly run "the new test
 * against the old code", we check out the parent tree into a throwaway worktree and OVERLAY the
 * fix's version of the test file(s) onto it, then run. Running the parent's own (absent/old) test
 * would prove nothing.
 *
 * Runner-agnostic: the verdict turns only on the test command's EXIT CODE (0 ⇒ passed, non-zero ⇒
 * failed), so it works with bun test, jest, pytest, go test, etc. Counts are parsed opportunistically
 * for reporting but never gate the decision.
 */

import { execFileSync, execSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { mustFailOnParent, type TestOutcome, type GateVerdict } from './gate'

/** A git worktree contains only tracked files; symlink node_modules so real projects resolve deps. */
export function linkNodeModules(repo: string, wt: string): void {
  try {
    const nm = resolve(repo, 'node_modules')
    if (existsSync(nm) && !existsSync(join(wt, 'node_modules'))) symlinkSync(nm, join(wt, 'node_modules'), 'dir')
  } catch { /* best-effort */ }
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
}

/** `git show <ref>:<path>` — the file content at a ref, or undefined if absent there. */
function showFile(repo: string, ref: string, path: string): string | undefined {
  try {
    return execFileSync('git', ['-C', repo, 'show', `${ref}:${path}`], { encoding: 'utf8' })
  } catch {
    return undefined
  }
}

function runTestCmd(cwd: string, testCmd: string): TestOutcome {
  try {
    const out = execSync(testCmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return parseCounts(out, 0)
  } catch (e: any) {
    // non-zero exit = failing test(s). Distinguish a genuine run from a command-not-found infra error.
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`
    if (e.code === 'ENOENT' || /command not found|not found/i.test(out)) return { ran: false, failed: 0, passed: 0 }
    return parseCounts(out, e.status ?? 1)
  }
}

function parseCounts(out: string, exit: number): TestOutcome {
  const pass = Number(out.match(/(\d+)\s+pass/)?.[1] ?? (exit === 0 ? 1 : 0))
  const fail = Number(out.match(/(\d+)\s+fail/)?.[1] ?? (exit === 0 ? 0 : 1))
  return { ran: true, passed: pass, failed: exit === 0 ? fail : Math.max(fail, 1) }
}

/**
 * Run `testCmd` against `ref`'s tree, overlaying `overlayFrom`'s version of `testPaths` (used to
 * put the NEW test onto the OLD code). Returns the test outcome.
 */
function runAtRef(repo: string, ref: string, testCmd: string, testPaths: string[], overlayFrom?: string): TestOutcome {
  const wt = mkdtempSync(join(tmpdir(), 'vgate-'))
  try {
    execFileSync('git', ['-C', repo, 'worktree', 'add', '--detach', '--force', wt, ref], { stdio: 'ignore' })
    linkNodeModules(repo, wt)
    if (overlayFrom && overlayFrom !== ref) {
      for (const p of testPaths) {
        const content = showFile(repo, overlayFrom, p)
        if (content === undefined) continue
        const dest = join(wt, p)
        mkdirSync(dirname(dest), { recursive: true })
        writeFileSync(dest, content)
      }
    }
    return runTestCmd(wt, testCmd)
  } finally {
    execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', wt], { stdio: 'ignore' })
    rmSync(wt, { recursive: true, force: true })
  }
}

/**
 * Validate a change through the must-fail-on-parent gate.
 *  - parent run: new test (from fixRef) overlaid onto parentRef's code → MUST fail.
 *  - fix run:    the fix commit as-is → MUST pass.
 */
export function validateChange(opts: {
  repo: string
  parentRef: string
  fixRef: string
  testPaths: string[]
  testCmd: string
}): GateVerdict {
  const parent = runAtRef(opts.repo, opts.parentRef, opts.testCmd, opts.testPaths, opts.fixRef)
  const fix = runAtRef(opts.repo, opts.fixRef, opts.testCmd, opts.testPaths)
  return mustFailOnParent(parent, fix)
}

export { git }
