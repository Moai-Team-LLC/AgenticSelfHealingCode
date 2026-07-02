/**
 * Loop B — signal extraction for the discriminator (the driver-side heuristics).
 *
 * Pure over strings so they are unit-testable; ./analyze.ts feeds them real test output and diffs.
 * Heuristic by nature (a production build would use the runner's structured result + a coverage map);
 * documented as such.
 */

/**
 * crash vs assertion. A clean `expect(...).toBe/toEqual/...` mismatch is an assertion (a candidate for
 * a stale-test heal). A thrown error / type error / timeout is a crash (never a heal — spec step 3).
 * Order matters: an assertion failure line wins even though a stack may also be present.
 */
export function classifyFailureMode(output: string): 'crash' | 'assertion' {
  const assertion = /\bexpect\(|toBe(?:Truthy|Falsy|Null|Defined|GreaterThan|LessThan|CloseTo)?\b|toEqual\b|toStrictEqual\b|toMatch\b|toContain\b|toThrow\b/
  const crash = /\b(TypeError|ReferenceError|RangeError|SyntaxError|is not a function|is not defined|Cannot read|timed out|timeout)\b|Unhandled|uncaught/i
  if (assertion.test(output)) return 'assertion'
  if (crash.test(output)) return 'crash'
  return 'crash' // conservative: an unrecognized red is treated as a crash → regression, never auto-heal
}

/**
 * Does the failing test exercise code OUTSIDE the change diff? Proxy: the test's relative imports vs
 * the set of changed source files (by basename). If the test imports a module the change did not touch,
 * the break is a side-effect → regression (spec step 4). Under-approximates (only static relative
 * imports); a production build uses a real per-test coverage map.
 */
export function coversOutsideDiff(testSource: string, changedSources: string[]): boolean {
  const changed = new Set(changedSources.map(baseNoExt))
  const imports = [...testSource.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)].map((m) => baseNoExt(m[1]))
  if (imports.length === 0) return false // no discernible imports → cannot claim it's outside; stay ambiguous
  return imports.some((imp) => !changed.has(imp))
}

function baseNoExt(p: string): string {
  const base = p.split('/').pop() ?? p
  return base.replace(/\.(test|spec)$/, '').replace(/\.[cm]?[jt]sx?$/, '')
}
