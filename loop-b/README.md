# Loop B — test-suite self-healing (core)

Runnable reference implementation of `../LOOP-B-SPEC.md` — the loop that ships **regardless of the
D10 verdict** (`../ARCHITECTURE-REFRAMED.md` §8), so it's the natural first thing to build.

## The load-bearing algorithm: the A/B/C/D discriminator

A test goes red after a code change. Its class decides everything, because a wrong "heal" has
**temporally-unbounded blast radius** (a loosened guard silently protects every future change):

| Class | What | Action | Autonomous? |
|---|---|---|---|
| **A_regression** | the change broke real behavior | leave red, alert — **never heal** | no |
| **B_stale_candidate** | intended behavior change; test encodes the old value | PR-time **author** prompt (the intent oracle); an approved heal is validated by `../verification-gate` | no |
| **C_flaky** | non-deterministic | **auto-quarantine** (skip-tag + evidence PR) | **yes — the one autonomous action** |
| **D_infra** | didn't run (compile/import/fixture) | route to build-fix | no |

Only quarantine is autonomous — it asserts *no behavior*, so its blast radius is ~zero. Healing is
**never** autonomous; it is a PR-time assist to the author who made the change. (`discriminator.ts`.)

The decision order matters and is enforced: rule out **flakiness** before reading a red as a
regression; a **crash** or a break in code **outside the change diff** is a regression *before* it is
ever a heal candidate. Only a clean assertion mismatch on code *inside* the diff is ambiguous → the
author decides.

## Run

```bash
bun test        # discriminator (all 5 branches) + flaky detector + quarantine + signal heuristics — 10 pass
bun run demo.ts # live: flaky→C, stale→B, crash→A on a throwaway repo, incl. the quarantine rewrite
```

Demo (abridged):

```
flaky   → C_flaky (AUTONOMOUS)  → test.skip('flaky roll') + // @flaky quarantined marker
stale   → B_stale_candidate (human-gated) → author prompt; heal validated by verification-gate
crash   → A_regression (human-gated) → leave red, never heal
```

## Files

- `discriminator.ts` — **pure** decision (steps 1–5 of the spec) over four signals → `Decision`.
- `signals.ts` — driver-side heuristics (pure over strings): `classifyFailureMode` (crash vs
  assertion) and `coversOutsideDiff` (test imports vs the changed-file set). Under-approximating by
  design — a production build uses the runner's structured result + a per-test coverage map.
- `flaky.ts` — `detectFlaky` (re-run N times, flaky iff results disagree) + `quarantineTest`
  (rewrite `test('x'` → `test.skip('x'` for the named test only, stamped with re-run evidence).
- `analyze.ts` — the driver: runs the test, re-runs for flakiness, extracts signals, classifies.
- `demo.ts` / `loop-b.test.ts`.

## Where it plugs in

- A **B_stale_candidate** the author approves becomes a test edit that must clear
  `../verification-gate` (must-fail-on-parent + no-weakening) exactly like any other change — Loop B
  does not get a bypass.
- **C_flaky** quarantines and coverage-gap generation (deferred, `../LOOP-B-SPEC.md`) open PRs that
  run through the same `../gate/cli.ts` in CI.
- Autonomy for quarantine is bounded server-side (`../SECURITY-THREATMODEL.md` §5.1) and every action
  is auditable (`../ORCHESTRATION.md`).
