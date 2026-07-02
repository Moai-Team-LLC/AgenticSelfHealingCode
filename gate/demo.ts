/**
 * End-to-end demo of the integrated Verification Gate (verify.ts) against a real git repo.
 *
 * One buggy parent, two candidate fixes off it:
 *   - fix-strong: correct code + a strong suite → both gates green → GateResult.pass = true.
 *   - fix-weak:   correct code + a discriminating-but-thin suite → must-fail PASSES but mutation
 *                 REJECTS → GateResult.pass = false. Shows the two gates are complementary: a real
 *                 regression test is not enough if the suite is too weak (D4 / Principle 6).
 *
 * Run:  bun run demo.ts
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verify } from './verify'

const g = (repo: string, ...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' })
const rev = (repo: string) => execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const w = (repo: string, p: string, c: string) => writeFileSync(join(repo, p), c)

const MODULE_BUG = `export function classify(n) {
  if (n > 100) return 'big'
  if (n < 0) return 'neg'
  return 'mid'
}
export function add(a, b) {
  return a - b
}
export function bothPositive(a, b) {
  return a > 0 && b > 0
}
`
const MODULE_FIX = MODULE_BUG.replace('return a - b', 'return a + b')

const STRONG = `import { test, expect } from 'bun:test'
import { classify, add, bothPositive } from './calc.js'
test('add', () => { expect(add(2, 3)).toBe(5) })
test('classify big', () => { expect(classify(101)).toBe('big') })
test('classify 100', () => { expect(classify(100)).toBe('mid') })
test('classify neg', () => { expect(classify(-1)).toBe('neg') })
test('classify 0', () => { expect(classify(0)).toBe('mid') })
test('bothPositive', () => {
  expect(bothPositive(1, 1)).toBe(true)
  expect(bothPositive(0, 1)).toBe(false)
  expect(bothPositive(1, 0)).toBe(false)
})
`
const WEAK = `import { test, expect } from 'bun:test'
import { add } from './calc.js'
test('add is 5', () => { expect(add(2, 3)).toBe(5) })
`

const repo = mkdtempSync(join(tmpdir(), 'vgate-int-'))
try {
  g(repo, 'init', '-q'); g(repo, 'config', 'user.email', 'd@x.dev'); g(repo, 'config', 'user.name', 'd'); g(repo, 'config', 'commit.gpgsign', 'false')
  w(repo, 'calc.js', MODULE_BUG); g(repo, 'add', '-A'); g(repo, 'commit', '-qm', 'parent: add bug')
  const parent = rev(repo)

  w(repo, 'calc.js', MODULE_FIX); w(repo, 'calc.strong.test.js', STRONG); g(repo, 'add', '-A'); g(repo, 'commit', '-qm', 'fix + strong suite')
  const fixStrong = rev(repo)

  g(repo, 'checkout', '-q', parent); g(repo, 'checkout', '-qb', 'weak')
  w(repo, 'calc.js', MODULE_FIX); w(repo, 'calc.weak.test.js', WEAK); g(repo, 'add', '-A'); g(repo, 'commit', '-qm', 'fix + weak suite')
  const fixWeak = rev(repo)

  const line = '═'.repeat(70)
  console.log(line)
  console.log('  VERIFICATION GATE — integrated verify(parent, fix, module) [live]')
  console.log(line)

  const scenarios = [
    { name: 'fix + STRONG suite', fix: fixStrong, test: 'calc.strong.test.js' },
    { name: 'fix + WEAK suite (real regression test, thin coverage)', fix: fixWeak, test: 'calc.weak.test.js' },
  ]
  for (const s of scenarios) {
    const r = verify({
      repo, parentRef: parent, fixRef: s.fix,
      testPaths: [s.test], sourceFiles: ['calc.js'], testCmd: `bun test ${s.test}`,
      requiredMutationScore: 0.75, classDiffBudget: 15, loop: 'C', tier: 2,
    })
    console.log(`\n  ${s.name}`)
    console.log(`    GateResult.pass = ${r.pass ? 'TRUE  ✅' : 'FALSE ❌'}   (${r.reason})`)
    console.log(`      must-fail-on-parent: ${r.signals.mustFailOnParent.pass ? 'pass' : 'REJECT'} (${r.signals.mustFailOnParent.code})`)
    console.log(`      mutation score:      ${r.signals.mutationScore.score?.toFixed(2)} / ${r.signals.mutationScore.threshold}  (${r.signals.mutationScore.killed}/${r.signals.mutationScore.total} killed) → ${r.signals.mutationScore.pass ? 'pass' : 'REJECT'}`)
    console.log(`      no-weakening:        ${r.signals.noWeakening ? (r.signals.noWeakening.pass ? 'pass' : 'REJECT') : 'n/a (new test)'}`)
    console.log(`      diffLines: ${r.signals.diffLines}  exceedsClassBudget: ${r.signals.exceedsClassBudget}  moduleArea: ${r.context.moduleArea}`)
  }
  console.log(`\n${line}`)
} finally {
  execFileSync('git', ['-C', repo, 'worktree', 'prune'], { stdio: 'ignore' })
  rmSync(repo, { recursive: true, force: true })
}
