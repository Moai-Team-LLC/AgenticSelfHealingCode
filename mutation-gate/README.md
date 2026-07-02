# Mutation-Score Gate — "is the suite strong enough?"

Runnable reference implementation of the strength bar in `../VERIFICATION-GATE.md` (gate S5,
decision D4). The companion to `../verification-gate/` (must-fail-on-parent): that one proves *a
test* discriminates; this one proves *the suite* would catch a bug at all.

## Why coverage is the wrong bar, and this is the right one

Line/branch coverage says a line **ran** — a vacuous test satisfies it trivially. The honest bar is
**mutation score**: mutate the touched module (flip `+`→`-`, `>`→`>=`, `&&`→`||`, …), run the suite
against each mutant. A mutant the suite **fails on** is *killed*; one it still **passes** is
*survived* — a behavior the suite does not actually verify. `score = killed / total`.

Below the per-class effective bar (`trust_controller.yaml`: L1=0.60, L2=0.75, L3=0.80) the class is
**ineligible for auto-apply**. This is the concrete enforcement of the *permanent squeeze*
(ARCHITECTURE-ORIGINAL §0.6, STRESS-TEST §1/§6, D4): a weakly-tested module can never earn autonomy,
because verification over it means nothing — exactly the bootstrapping honesty the reframe insists on.

## Run

```bash
bun test        # pure-logic unit tests (mutation generation + score decision) — 6 pass
bun run demo.ts # same module, STRONG vs WEAK suite, live
```

Demo output — the whole point in three lines:

```
STRONG suite → mutants 10 · killed 10 · score 1.00 → PASS ✅ eligible
WEAK suite   → mutants 10 · killed  1 · score 0.10 → REJECT ❌ ineligible
             survivors: L2 >→>=, L10 >→<, …  (the boundaries the weak suite never checks)
```

## Files

- `gate.ts` — **pure**, unit-tested: `mutate(src)` (one mutant per operator occurrence, with
  string/comment masking so operators inside literals are never mutated) and `scoreGate(results,
  threshold) → ScoreReport` (the killed/total decision, survivor list, ineligible-on-zero-mutants).
- `runner.ts` — the driver: writes each mutant over the file, runs the test command, classifies by
  **exit code** (runner-agnostic — bun/jest/vitest/pytest/go), always restores the original.
- `demo.ts` — builds a throwaway module + a strong and a weak suite, runs the gate on each.
- `gate.test.ts` — pins masking, mutant generation, compound-operator safety, and score decisions.

## Honest scope

String-level operator mutation with literal/comment masking — deliberately minimal, to demonstrate
the **gate mechanic** cleanly and verifiably. A production gate uses an AST-based engine
(**StrykerJS** for TS/JS) for full operator coverage, equivalent-mutant handling, and
incremental/per-diff runs. The decision layer (`scoreGate`) and the routing (per-class effective
threshold from the Trust Controller, `../ARCHITECTURE-REFRAMED.md` §2) are unchanged when you swap in
Stryker — this repo shows the shape the real gate plugs into.

## The two gates together

`../verification-gate/` (must-fail-on-parent) + this = the non-LLM core of the Verification Gate.
The first closes "the agent graded its own homework" (a test that passes on the buggy parent, attack
#4); the second closes "the suite is too weak for green to mean anything" (Principle 6). Neither uses
an LLM — independence comes from signals, not a second opinion (D8). The advisory judge sits on top,
fed these signals, never the RCA narrative.
