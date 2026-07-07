/**
 * GitWorktreeSandbox — the executor half of the sandboxed repair worker (repair-author.ts). It runs the
 * grounded repro cycle in an EPHEMERAL git worktree off the target repo: read files, write the regression
 * test, git-apply the candidate diff, commit onto the fix branch, and run the test command to OBSERVE the two
 * grounded booleans (fail-on-parent, pass-on-fix). Every git/test call is `execFileSync` with an argv array
 * (NO shell) and a hard wall-clock timeout; the worktree is torn down on close().
 *
 * ⚠️ SECURITY. `run()` executes UNTRUSTED, model-authored code. A git worktree + timeout is isolation-in-
 * process, NOT kernel isolation. In production this class MUST run inside the SECURITY-THREATMODEL §4
 * container (non-root, read-only root FS, --cap-drop=ALL, seccomp default-deny, egress deny-by-default,
 * mem/CPU/PID caps, no prod secrets, prod network unreachable). This package cannot provide that; it refuses
 * to run unless the caller explicitly asserts `allowUntrustedExecution: true`, acknowledging the container is
 * in place. The fix commit lands on a real branch in the main repo so the gate and the PR can reach it after
 * the worktree is removed.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import type { RepairContext, RepairCheckResult } from '@sho/loop-c'
import type { RepairSandbox, SandboxSession } from './repair-author'

export interface GitWorktreeSandboxConfig {
  /** the target repo (a clean clone; in prod, inside the §4 container). */
  repo: string
  /** the base ref to reproduce against (the parent — e.g. the deployed sha or a branch). */
  baseRef: string
  /** the test command run in the worktree, as argv (no shell). e.g. ['bun','test','src/checkout']. */
  testCmd: string[]
  /** hard wall-clock cap per test run. Default 120_000ms. */
  timeoutMs?: number
  /** the fix branch is `${prefix}${incidentId}` (matches the GitHub publisher convention). Default 'sho/fix-'. */
  headBranchPrefix?: string
  /** extra gate checks (the operator's local dev gates as hooks): each a named argv run on the fix worktree,
   *  e.g. [{name:'typecheck', argv:['tsc','--noEmit']}, {name:'security', argv:['semgrep','--error']}]. Non-zero → fail. */
  checks?: { name: string; argv: string[] }[]
  /** REQUIRED explicit acknowledgment that run() executes untrusted code inside the §4 container. */
  allowUntrustedExecution: true
}

function git(repo: string, args: string[], input?: string): { code: number; out: string } {
  try {
    const out = execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: input === undefined ? ['ignore', 'pipe', 'ignore'] : ['pipe', 'pipe', 'ignore'],
      input,
    })
    return { code: 0, out }
  } catch (e) {
    const err = e as { status?: number; stdout?: string }
    return { code: err.status ?? 1, out: err.stdout ?? '' }
  }
}

export function gitWorktreeSandbox(cfg: GitWorktreeSandboxConfig): RepairSandbox {
  if (cfg.allowUntrustedExecution !== true) {
    throw new Error(
      'gitWorktreeSandbox executes untrusted model-authored code and requires allowUntrustedExecution:true ' +
        '— set it only when running inside the SECURITY-THREATMODEL §4 container.',
    )
  }
  const timeoutMs = cfg.timeoutMs ?? 120_000
  const branchPrefix = cfg.headBranchPrefix ?? 'sho/fix-'

  return {
    open(ctx: RepairContext): SandboxSession {
      const baseSha = git(cfg.repo, ['rev-parse', cfg.baseRef]).out.trim()
      const wt = mkdtempSync(join(tmpdir(), 'sho-repair-'))
      const add = git(cfg.repo, ['worktree', 'add', '--detach', '--force', wt, cfg.baseRef])
      if (add.code !== 0) {
        rmSync(wt, { recursive: true, force: true })
        throw new Error(`sandbox: could not create worktree at ${cfg.baseRef}`)
      }
      const headBranch = `${branchPrefix}${ctx.incidentId}`
      let closed = false

      return {
        baseSha,
        repo: cfg.repo,
        readFile(path) {
          const abs = join(wt, path)
          try { return readFileSync(abs, 'utf8') } catch { return null }
        },
        writeFile(path, content) {
          const abs = join(wt, path)
          mkdirSync(dirname(abs), { recursive: true })
          writeFileSync(abs, content, 'utf8')
        },
        applyDiff(diff) {
          // Standard git diff format (a/ b/ prefixes, default -p1). --index stages it for the commit. No shell.
          return git(wt, ['apply', '--whitespace=nowarn', '--index', '-'], diff).code === 0
        },
        run() {
          try {
            execFileSync(cfg.testCmd[0]!, cfg.testCmd.slice(1), { cwd: wt, timeout: timeoutMs, stdio: 'ignore' })
            return { exitCode: 0 }
          } catch (e) {
            const err = e as { status?: number }
            return { exitCode: err.status ?? 1 }
          }
        },
        runNamedChecks(): RepairCheckResult[] {
          return (cfg.checks ?? []).map((c) => {
            try {
              execFileSync(c.argv[0]!, c.argv.slice(1), { cwd: wt, timeout: timeoutMs, stdio: 'ignore' })
              return { name: c.name, passed: true }
            } catch {
              return { name: c.name, passed: false }
            }
          })
        },
        commit(message) {
          git(wt, ['add', '-A'])
          git(wt, ['-c', 'user.email=sho-repair@localhost', '-c', 'user.name=sho-repair', 'commit', '--no-verify', '-m', message])
          const fixSha = git(wt, ['rev-parse', 'HEAD']).out.trim()
          // Publish onto the fix branch in the MAIN repo so it survives worktree removal (gate + PR reach it).
          git(cfg.repo, ['branch', '-f', headBranch, fixSha])
          return fixSha
        },
        close() {
          if (closed) return
          closed = true
          git(cfg.repo, ['worktree', 'remove', '--force', wt])
          if (existsSync(wt)) rmSync(wt, { recursive: true, force: true })
        },
      }
    },
  }
}
