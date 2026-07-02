/**
 * Loop B — flaky detection + quarantine (the ONE autonomous Loop B action, LOOP-B-SPEC.md).
 *
 * Quarantining asserts NO behavior — it only marks non-determinism — so its blast radius is ~zero and
 * it can be automated. Worst case a real failure gets muted, and the evidence-PR surfaces it.
 */

export interface FlakyResult { flaky: boolean; runs: number; passes: number; fails: number }

/** Re-run a test on UNCHANGED code N times; flaky iff results disagree. `runOnce` returns true=pass. */
export function detectFlaky(runOnce: () => boolean, runs = 10): FlakyResult {
  let passes = 0
  for (let i = 0; i < runs; i++) if (runOnce()) passes++
  return { flaky: passes > 0 && passes < runs, runs, passes, fails: runs - passes }
}

/**
 * Quarantine a single test by name: rewrite `test('name'`/`it("name"` → `test.skip(...)` and stamp a
 * traceable marker. Skips only the named test, not the whole file. Returns changed=false if not found
 * (so the caller can fall back to a skip-list). CI treats skipped as non-blocking; the PR carries the
 * re-run evidence for human triage.
 */
export function quarantineTest(src: string, testName: string, evidence: string): { changed: boolean; src: string } {
  const esc = testName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`\\b(test|it)\\((['"\`])${esc}\\2`)
  if (!re.test(src)) return { changed: false, src }
  const marked = src.replace(re, (m, fn) => `${fn}.skip(` + m.slice(m.indexOf('(') + 1))
  const banner = `// @flaky quarantined by Loop B — ${evidence}\n`
  return { changed: true, src: banner + marked }
}
