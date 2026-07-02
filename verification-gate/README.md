# Verification Gate — must-fail-on-parent kernel

Runnable reference implementation of the non-LLM heart of `../VERIFICATION-GATE.md` (gates S4/S6,
decisions D4/D8). It is the mechanic that makes "the tests are green" mean something.

## Why this is the load-bearing piece

A repair agent (Loop C) or a heal (Loop B) writes **both** the fix and its regression test, then
"all tests green" clears the gate. The trap (STRESS-TEST attack #4): the generated test asserts the
*new* code's behavior and passes **vacuously**. Green is necessary, not sufficient.

The only mechanical, LLM-free check that closes this: run the **new test against the parent
(pre-fix) code — it MUST fail** — and against the fix — it MUST pass. A test that passes on the
buggy parent discriminates nothing. This is the discriminating-power check the very first stress
test flagged as missing, made concrete.

## Run

```bash
bun test        # unit tests for the pure verdict logic (7 pass)
bun run demo.ts # end-to-end against a throwaway git repo it builds and tears down
```

The demo output:

```
DISCRIMINATING regression test   → PASS ✅   (fails on parent, passes on fix)
VACUOUS test (passes on parent)  → REJECT ❌ (VACUOUS — attack #4 caught)
no-weakening: toBe(90)→not.toBeNull() → REJECT ❌ (guard loosened)
```

## Files

- `gate.ts` — **pure logic**, fully unit-tested, no I/O:
  - `mustFailOnParent(parentOutcome, fixOutcome) → GateVerdict` with codes `DISCRIMINATING` /
    `VACUOUS` / `UNFIXED` / `INFRA`. Only `failed === 0` vs `> 0` is load-bearing.
  - `noWeakening(parentSrc?, fixSrc) → WeakeningVerdict` — a heal must not net-loosen assertion
    strength (LOOP-B-SPEC.md guard #2); a brand-new test passes trivially.
- `git-runner.ts` — the driver. `validateChange({repo, parentRef, fixRef, testPaths, testCmd})`.
  The subtle part: a fix commit usually adds the test *with* the fix, so the parent tree has no such
  test — the driver checks out the parent into a `git worktree` and **overlays the fix's version of
  the test file(s)** before running. Running the parent's own (absent) test would prove nothing.
- `demo.ts` — builds a real repo (buggy `add` → fix + tests), drives the gate, cleans up.
- `gate.test.ts` — unit tests pinning every verdict code and the weakening heuristic.

## Runner-agnostic

The verdict turns only on the test command's **exit code** (0 ⇒ passed, non-zero ⇒ failed), so it
works with `bun test`, `jest`, `vitest`, `pytest`, `go test`, etc. Test counts are parsed
opportunistically for reporting but never gate the decision. A command that can't execute at all
(`ENOENT`) yields `ran: false` → `INFRA` reject, never a silent pass.

## What this is not

It is one gate, not the whole Verification Gate. The full battery (`../VERIFICATION-GATE.md`) also
runs the complete suite, types, lint, static/security analysis, the **mutation-score** gate (the
"is the suite strong enough" bar, D4), the reversibility probe (D2), and an *advisory* judge fed
these signals (not the RCA narrative — D8). This kernel is the sharpest, most universal of them and
the natural first build; mutation scoring (e.g. StrykerJS) layers on top.
