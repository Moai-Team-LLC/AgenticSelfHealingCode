import { test, expect } from 'bun:test'
import { classify, type BrokenSignals } from './src/discriminator'
import { detectFlaky, quarantineTest } from './src/flaky'
import { classifyFailureMode, coversOutsideDiff } from './src/signals'
import { analyzeBrokenTest, parseRunOutput, type AnalyzeDeps, type RunOutcome } from './src/analyze'
import * as contracts from '@sho/contracts'
import type { BrokenClass, LoopBDecision } from '@sho/contracts'

const sig = (o: Partial<BrokenSignals>): BrokenSignals => ({ ran: true, flaky: false, failureMode: 'assertion', coversOutsideDiff: false, ...o })

// ---- the shared contract is the source of BrokenClass / LoopBDecision ----
test('BrokenClass values and LoopBDecision shape come from @sho/contracts', () => {
  // A decision produced here is assignable to the contract's LoopBDecision (compile + runtime shape).
  const d: LoopBDecision = classify(sig({}))
  expect(new Set(Object.keys(d))).toEqual(new Set(['cls', 'autonomous', 'action', 'reason']))
  // Every class the discriminator emits is a member of the contract's BrokenClass union.
  const classes: BrokenClass[] = ['A_regression', 'B_stale_candidate', 'C_flaky', 'D_infra']
  expect(classes).toContain(classify(sig({ ran: false })).cls)
  // The contract module is the one exporting the taxonomy names/types (no local re-declaration).
  expect(contracts).toHaveProperty('normalizeIncidentCandidate') // sibling contract export exists
})

// ---- discriminator (all five branches) ----
test('D_infra when the test did not run', () => {
  expect(classify(sig({ ran: false })).cls).toBe('D_infra')
})
test('C_flaky is the only autonomous class', () => {
  const d = classify(sig({ flaky: true }))
  expect(d.cls).toBe('C_flaky')
  expect(d.autonomous).toBe(true)
})
test('crash → A_regression, never heal', () => {
  const d = classify(sig({ failureMode: 'crash' }))
  expect(d.cls).toBe('A_regression')
  expect(d.autonomous).toBe(false)
})
test('break outside the diff → A_regression', () => {
  expect(classify(sig({ coversOutsideDiff: true })).cls).toBe('A_regression')
})
test('clean assertion mismatch inside the diff → B_stale_candidate (human-gated)', () => {
  const d = classify(sig({}))
  expect(d.cls).toBe('B_stale_candidate')
  expect(d.autonomous).toBe(false)
})
test('flakiness is ruled out before crash/regression (order)', () => {
  expect(classify(sig({ flaky: true, failureMode: 'crash' })).cls).toBe('C_flaky')
})
test('decision order: flaky < crash < out-of-diff < stale-candidate', () => {
  // flaky beats crash (step 2 before 3)
  expect(classify(sig({ flaky: true, failureMode: 'crash', coversOutsideDiff: true })).cls).toBe('C_flaky')
  // crash beats out-of-diff (step 3 before 4)
  expect(classify(sig({ failureMode: 'crash', coversOutsideDiff: true })).cls).toBe('A_regression')
  // out-of-diff beats stale-candidate (step 4 before 5)
  expect(classify(sig({ failureMode: 'assertion', coversOutsideDiff: true })).cls).toBe('A_regression')
  // nothing left → stale-candidate (step 5)
  expect(classify(sig({ failureMode: 'assertion', coversOutsideDiff: false })).cls).toBe('B_stale_candidate')
})

// ---- flaky ----
test('detectFlaky: inconsistent → flaky; consistent → not', () => {
  let i = 0
  const alt = () => (i++ % 2 === 0) // T,F,T,F...
  expect(detectFlaky(alt, 6).flaky).toBe(true)
  expect(detectFlaky(() => true, 6).flaky).toBe(false)
  expect(detectFlaky(() => false, 6).flaky).toBe(false)
})
test('quarantineTest skips only the named test and stamps a marker', () => {
  const src = "test('a', () => {})\ntest('flaky one', () => {})\n"
  const q = quarantineTest(src, 'flaky one', 'p=6/10')
  expect(q.changed).toBe(true)
  expect(q.src).toContain("test.skip('flaky one'")
  expect(q.src).toContain("test('a'") // untouched
  expect(q.src).toContain('@flaky quarantined')
  expect(quarantineTest(src, 'missing', 'x').changed).toBe(false)
})

// ---- signals ----
test('classifyFailureMode: assertion vs crash vs unknown→crash', () => {
  expect(classifyFailureMode('expect(received).toBe(expected)')).toBe('assertion')
  expect(classifyFailureMode('TypeError: parse is not a function')).toBe('crash')
  expect(classifyFailureMode('some opaque red')).toBe('crash') // conservative
})
test('coversOutsideDiff: import outside the change → true; inside → false', () => {
  const testSrc = "import { f } from './helper.js'\nimport { g } from './price.js'"
  expect(coversOutsideDiff(testSrc, ['src/price.ts'])).toBe(true) // helper not in diff
  expect(coversOutsideDiff("import { g } from './price.js'", ['src/price.ts'])).toBe(false)
  expect(coversOutsideDiff('no imports here', ['src/price.ts'])).toBe(false)
})

// ---- analyze driver (infrastructure behind an injected in-memory fake — no fs/child_process) ----
const fakeDeps = (output: string, testSource: string): AnalyzeDeps => ({
  runTestOnce: (): RunOutcome => parseRunOutput(output),
  readTestSource: () => testSource,
})

test('parseRunOutput: counts pass/fail from bun-style output', () => {
  expect(parseRunOutput('3 pass 0 fail')).toEqual({ ran: true, passed: true, output: '3 pass 0 fail' })
  expect(parseRunOutput('1 pass 2 fail').passed).toBe(false)
  expect(parseRunOutput('no counts here').ran).toBe(false)
})
test('analyzeBrokenTest: green test → not broken (no decision)', () => {
  const a = analyzeBrokenTest('/repo', 'x.test.ts', ['src/x.ts'], 4, fakeDeps('2 pass 0 fail', "import {x} from './x.js'"))
  expect(a.broken).toBe(false)
  expect(a.decision).toBeUndefined()
})
test('analyzeBrokenTest: clean assertion red inside diff → B_stale_candidate', () => {
  const out = '1 pass 1 fail\nexpect(received).toBe(expected)'
  const a = analyzeBrokenTest('/repo', 'price.test.ts', ['src/price.ts'], 3, fakeDeps(out, "import { g } from './price.js'"))
  expect(a.broken).toBe(true)
  expect(a.decision?.cls).toBe('B_stale_candidate')
  expect(a.signals?.flaky).toBe(false) // deterministic red across reruns
})
test('analyzeBrokenTest: crash red → A_regression', () => {
  const out = '0 pass 1 fail\nTypeError: parse is not a function'
  const a = analyzeBrokenTest('/repo', 'p.test.ts', ['src/p.ts'], 3, fakeDeps(out, "import { p } from './p.js'"))
  expect(a.decision?.cls).toBe('A_regression')
  expect(a.decision?.autonomous).toBe(false)
})
