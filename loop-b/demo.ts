/**
 * Loop B — live demo. Builds a throwaway dir with three red-test scenarios and runs analyzeBrokenTest,
 * showing the discriminator route each to the correct class:
 *   - flaky (non-deterministic)         → C_flaky (autonomous quarantine; shows the skip rewrite)
 *   - stale expectation on changed code → B_stale_candidate (human-gated PR-time author heal)
 *   - crash after a change              → A_regression (leave red, never heal)
 *
 * Run:  bun run demo.ts
 */

import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeBrokenTest } from './analyze'
import { quarantineTest } from './flaky'

const dir = mkdtempSync(join(tmpdir(), 'loop-b-'))
const w = (p: string, c: string) => writeFileSync(join(dir, p), c)

try {
  // 1) flaky
  w('flaky.test.js', "import { test, expect } from 'bun:test'\ntest('flaky roll', () => { expect(Math.random() < 0.5).toBe(true) })\n")
  // 2) stale expectation: greet already changed to 'hello', the test still asserts the old 'hi'
  w('greet.js', "export const greet = () => 'hello'\n")
  w('greet.test.js', "import { test, expect } from 'bun:test'\nimport { greet } from './greet.js'\ntest('greets', () => { expect(greet()).toBe('hi') })\n")
  // 3) crash: parse() was removed from util in the change; the test calls it → TypeError
  w('util.js', "export const size = (a) => a.length\n")
  w('util.test.js', "import { test, expect } from 'bun:test'\nimport { parse } from './util.js'\ntest('parses', () => { expect(parse('x')).toBe('x') })\n")

  const line = '═'.repeat(70)
  console.log(line)
  console.log('  LOOP B — A/B/C/D discriminator (live)')
  console.log(line)

  const cases = [
    { name: 'flaky (non-deterministic)', test: 'flaky.test.js', changed: [] },
    { name: 'stale expectation on changed code', test: 'greet.test.js', changed: ['greet.js'] },
    { name: 'crash after a change', test: 'util.test.js', changed: ['util.js'] },
  ]
  for (const c of cases) {
    const a = analyzeBrokenTest(dir, c.test, c.changed, 12)
    console.log(`\n  ${c.name}  [${c.test}]`)
    if (!a.broken) { console.log('    → green (not broken)'); continue }
    console.log(`    signals: ran=${a.signals!.ran} flaky=${a.signals!.flaky} mode=${a.signals!.failureMode} outsideDiff=${a.signals!.coversOutsideDiff}`)
    console.log(`    → ${a.decision!.cls}  ${a.decision!.autonomous ? '(AUTONOMOUS)' : '(human-gated)'}`)
    console.log(`      ${a.decision!.action}`)
  }

  // show the one autonomous action end-to-end
  const q = quarantineTest(readFileSync(join(dir, 'flaky.test.js'), 'utf8'), 'flaky roll', 'passes 5/12 on unchanged code')
  console.log('\n  autonomous quarantine rewrite (flaky.test.js):')
  console.log('    ' + q.src.split('\n').filter(Boolean).join('\n    '))
  console.log(`\n${line}`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
