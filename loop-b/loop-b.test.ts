import { test, expect } from 'bun:test'
import { classify, type BrokenSignals } from './discriminator'
import { detectFlaky, quarantineTest } from './flaky'
import { classifyFailureMode, coversOutsideDiff } from './signals'

const sig = (o: Partial<BrokenSignals>): BrokenSignals => ({ ran: true, flaky: false, failureMode: 'assertion', coversOutsideDiff: false, ...o })

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
