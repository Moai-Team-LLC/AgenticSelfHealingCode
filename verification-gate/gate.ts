/**
 * Verification Gate — the non-LLM kernel (VERIFICATION-GATE.md S4/S6, D4/D8).
 *
 * The single mechanic that makes "the tests are green" mean something: a regression/heal test
 * MUST FAIL on the parent commit (for a behavior reason) and PASS on the fix commit. A test that
 * passes on the pre-fix code discriminates nothing — it is the "agent grades its own homework"
 * failure (STRESS-TEST attack #4). Plus a no-weakening check for heals (a heal must not loosen a
 * guard). Both are pure, deterministic decisions over test OUTCOMES/SOURCE — no LLM, no narrative.
 *
 * This file is the pure logic (fully unit-tested). The git/test-runner driver is ./git-runner.ts.
 */

export interface TestOutcome {
  ran: boolean // did the test command execute at all (vs. a broken-infra non-run)
  failed: number // number of failing tests (only failed===0 vs >0 is load-bearing)
  passed: number
}

export interface GateVerdict {
  gate: 'must-fail-on-parent'
  pass: boolean
  code: 'DISCRIMINATING' | 'VACUOUS' | 'UNFIXED' | 'INFRA'
  reason: string
  parent: TestOutcome
  fix: TestOutcome
}

/**
 * The core gate. `parent` = the NEW test run against the PARENT (pre-fix) code; `fix` = the same
 * test run against the fix commit. The driver is responsible for overlaying the new test onto the
 * parent tree (a fix usually adds the test and the fix together — see git-runner.ts).
 */
export function mustFailOnParent(parent: TestOutcome, fix: TestOutcome): GateVerdict {
  const base = { gate: 'must-fail-on-parent' as const, parent, fix }
  if (!parent.ran || !fix.ran) {
    return { ...base, pass: false, code: 'INFRA', reason: 'test did not execute on one or both refs — broken infra, not a gate pass' }
  }
  if (parent.failed === 0) {
    return { ...base, pass: false, code: 'VACUOUS', reason: 'test PASSES on the parent (pre-fix) code — it discriminates nothing and cannot prove the fix (attack #4)' }
  }
  if (fix.failed > 0) {
    return { ...base, pass: false, code: 'UNFIXED', reason: 'test still FAILS on the fix commit — the change does not actually fix the behavior' }
  }
  return { ...base, pass: true, code: 'DISCRIMINATING', reason: 'fails on parent, passes on fix — the test is grounded and the fix is real' }
}

// ---- no-weakening (heals must not loosen an assertion) --------------------

const STRONG = [/\btoBe\b/g, /\btoEqual\b/g, /\btoStrictEqual\b/g, /\btoHaveBeenCalledWith\b/g, /\bassert(?:Equal|Strict|Equals)\b/g, /===/g]
const WEAK = [/\btoBeDefined\b/g, /\btoBeTruthy\b/g, /\btoBeFalsy\b/g, /\btoBeNull\b/g, /\btoHaveBeenCalled\b/g, /\btoBeGreaterThan\b/g, /\btoBeLessThan\b/g, /\.not\.toBeNull\b/g]

function count(src: string, pats: RegExp[]): number {
  return pats.reduce((n, p) => n + (src.match(p)?.length ?? 0), 0)
}

export interface WeakeningVerdict {
  pass: boolean
  reason: string
  strongParent: number
  strongFix: number
  weakParent: number
  weakFix: number
}

/**
 * A heal edits an existing test. It must not net-loosen the assertion strength — e.g. replacing
 * `expect(x).toBe(90)` with `expect(x).not.toBeNull()` silently disables the guard (LOOP-B-SPEC.md
 * guard #2). `parentSrc` undefined ⇒ a brand-new test (nothing to weaken).
 */
export function noWeakening(parentSrc: string | undefined, fixSrc: string): WeakeningVerdict {
  const strongFix = count(fixSrc, STRONG), weakFix = count(fixSrc, WEAK)
  if (parentSrc === undefined) {
    return { pass: true, reason: 'new test — nothing to weaken', strongParent: 0, strongFix, weakParent: 0, weakFix }
  }
  const strongParent = count(parentSrc, STRONG), weakParent = count(parentSrc, WEAK)
  if (strongFix < strongParent) {
    return { pass: false, reason: `heal drops strong assertions (${strongParent}→${strongFix}) — guard loosened`, strongParent, strongFix, weakParent, weakFix }
  }
  if (strongFix === strongParent && weakFix > weakParent) {
    return { pass: false, reason: `heal adds only weak assertions while strong count is unchanged (${weakParent}→${weakFix}) — likely loosened`, strongParent, strongFix, weakParent, weakFix }
  }
  return { pass: true, reason: `strong assertions preserved (${strongParent}→${strongFix})`, strongParent, strongFix, weakParent, weakFix }
}
