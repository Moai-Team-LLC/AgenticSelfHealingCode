/**
 * End-to-end demo of the mutation-score gate against a real module + two suites.
 *
 * Same module, two test suites:
 *   - STRONG suite pins boundaries → kills the mutants → high score → PASS (eligible).
 *   - WEAK suite tests almost nothing → mutants survive → low score → REJECT (ineligible).
 *
 * This is the whole point of D4: the gate distinguishes a suite that would CATCH a bug from one that
 * merely runs the code. Run:  bun run demo.ts
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runMutationGate } from './runner'

const CALC = `export function classify(n) {
  if (n > 100) return 'big'
  if (n < 0) return 'neg'
  return 'mid'
}
export function add(a, b) {
  return a + b
}
export function bothPositive(a, b) {
  return a > 0 && b > 0
}
`

const STRONG = `import { test, expect } from 'bun:test'
import { classify, add, bothPositive } from './calc.js'
test('add', () => { expect(add(2, 3)).toBe(5) })
test('classify big', () => { expect(classify(101)).toBe('big') })
test('classify boundary 100', () => { expect(classify(100)).toBe('mid') })
test('classify neg', () => { expect(classify(-1)).toBe('neg') })
test('classify boundary 0', () => { expect(classify(0)).toBe('mid') })
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

const dir = mkdtempSync(join(tmpdir(), 'mutgate-demo-'))
try {
  writeFileSync(join(dir, 'calc.js'), CALC)
  writeFileSync(join(dir, 'calc.strong.test.js'), STRONG)
  writeFileSync(join(dir, 'calc.weak.test.js'), WEAK)

  const line = '─'.repeat(66)
  console.log(line)
  console.log('  MUTATION-SCORE GATE — is the suite strong enough? (live, D4)')
  console.log(line)

  for (const [name, testFile] of [
    ['STRONG suite (pins boundaries)', 'calc.strong.test.js'],
    ['WEAK suite (tests almost nothing)', 'calc.weak.test.js'],
  ] as const) {
    const g = runMutationGate({ dir, sourceFile: 'calc.js', testCmd: `bun test ${testFile}`, threshold: 0.75 })
    console.log(`\n  ${name}  [${testFile}]  threshold=${g.threshold}`)
    console.log(`    mutants: ${g.total}   killed: ${g.killed}   survived: ${g.survived}   score: ${g.score?.toFixed(2)}`)
    console.log(`    → ${g.pass ? 'PASS ✅ eligible' : 'REJECT ❌ ineligible'} — ${g.reason}`)
    if (g.survivors.length) {
      const shown = g.survivors.slice(0, 6).map((s) => `L${s.line} ${s.op}`).join(', ')
      console.log(`    survivors: ${shown}${g.survivors.length > 6 ? ` … +${g.survivors.length - 6}` : ''}`)
    }
  }
  console.log(`\n${line}`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
