/**
 * End-to-end demo of the Verification Gate kernel against a REAL throwaway git repo.
 *
 * Builds a repo where the fix commit adds both the fix and its regression test, then drives
 * must-fail-on-parent through the git worktree overlay. Shows the gate:
 *   - PASSING a genuine, discriminating regression test, and
 *   - REJECTING a vacuous test that passes on the buggy parent too (attack #4).
 *
 * Run:  bun run demo.ts
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateChange } from './git-runner'
import { noWeakening } from './gate'

function git(repo: string, ...args: string[]) {
  execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
}
function write(repo: string, path: string, content: string) {
  writeFileSync(join(repo, path), content)
}

const repo = mkdtempSync(join(tmpdir(), 'vgate-demo-'))
try {
  git(repo, 'init', '-q')
  git(repo, 'config', 'user.email', 'demo@x.dev')
  git(repo, 'config', 'user.name', 'demo')
  git(repo, 'config', 'commit.gpgsign', 'false')

  // Parent commit: buggy add (subtracts).
  write(repo, 'calc.js', 'export const add = (a, b) => a - b\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'parent: buggy add')
  const parent = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

  // Fix commit: correct add + a DISCRIMINATING regression test + a VACUOUS one.
  write(repo, 'calc.js', 'export const add = (a, b) => a + b\n')
  write(repo, 'calc.good.test.js', "import { test, expect } from 'bun:test'\nimport { add } from './calc.js'\ntest('adds', () => { expect(add(2, 3)).toBe(5) })\n")
  write(repo, 'calc.vacuous.test.js', "import { test, expect } from 'bun:test'\nimport { add } from './calc.js'\ntest('exists', () => { expect(add(2, 3)).toBeDefined() })\n")
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'fix: correct add + tests')
  const fix = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

  const line = '─'.repeat(66)
  console.log(line)
  console.log('  VERIFICATION GATE — must-fail-on-parent (live, real git repo)')
  console.log(line)

  for (const [name, testPath] of [
    ['DISCRIMINATING regression test', 'calc.good.test.js'],
    ['VACUOUS test (passes on buggy parent too)', 'calc.vacuous.test.js'],
  ] as const) {
    const v = validateChange({ repo, parentRef: parent, fixRef: fix, testPaths: [testPath], testCmd: `bun test ${testPath}` })
    console.log(`\n  ${name}  [${testPath}]`)
    console.log(`    parent run: failed=${v.parent.failed}   fix run: failed=${v.fix.failed}`)
    console.log(`    → ${v.pass ? 'PASS ✅' : 'REJECT ❌'}  (${v.code}) — ${v.reason}`)
  }

  // no-weakening demo (heal that loosens a guard)
  const w = noWeakening('expect(total).toBe(90)', 'expect(total).not.toBeNull()')
  console.log(`\n  no-weakening: heal 'toBe(90)' → 'not.toBeNull()'`)
  console.log(`    → ${w.pass ? 'PASS ✅' : 'REJECT ❌'} — ${w.reason}`)
  console.log(`\n${line}`)
} finally {
  execFileSync('git', ['-C', repo, 'worktree', 'prune'], { stdio: 'ignore' })
  rmSync(repo, { recursive: true, force: true })
}
