# Verification Gate — integrated entrypoint

The single `verify(parentRef, fixRef, module) → GateResult` call the Orchestrator's router hands
every machine-authored change (`../VERIFICATION-GATE.md`, `../ORCHESTRATION.md` §4 router). It
composes the two non-LLM kernels into the one verdict the specs pass around.

## What it runs

| Signal | From | Hard gate? |
|---|---|---|
| **must-fail-on-parent** | `../verification-gate/` | yes — the new test must fail on parent, pass on fix (attack #4) |
| **mutation score** | `../mutation-gate/` | yes — suite strength ≥ the per-class effective bar (D4, Principle 6) |
| **no-weakening** | `../verification-gate/` | yes, when a test was *edited* (a heal); n/a for a new test |
| **diffLines / exceedsClassBudget** | git diff | **signal only** — feeds the Trust Controller's churn escalator; does not fail the gate here (split-brain avoidance) |

`pass = mustFail.pass && mutation.pass && (noWeakening?.pass ?? true)`. The gate **reports**; it does
not move tiers — that's the Trust Controller (`../TRUST-CONTROLLER.md`), which also supplies the
`requiredMutationScore` this call takes as input.

## Run

```bash
bun test        # pure combination logic (combineGate, mergeReports) — 6 pass
bun run demo.ts # live: one buggy parent, two fixes off it
```

The demo makes the complementarity concrete:

```
fix + STRONG suite → pass=TRUE   (must-fail pass · mutation 1.00 · )
fix + WEAK suite    → pass=FALSE  (must-fail PASS · mutation 0.10 REJECT)
```

The weak-suite fix ships a **real, discriminating** regression test — yet the gate rejects it,
because the surrounding suite is too weak for green to mean anything. Neither gate alone is enough.

## The call signature (what the router provides)

```ts
verify({
  repo, parentRef, fixRef,
  testPaths,             // the new/changed test file(s)
  sourceFiles,           // the touched module file(s) to mutate
  testCmd,               // any runner; verdict turns on exit code
  requiredMutationScore, // per-class effective bar from the Trust Controller
  classDiffBudget,       // for the exceedsClassBudget signal (default 15)
  loop, tier,            // context, passed through
}) → GateResult
```

## Running on real PRs (CI)

`cli.ts` wraps `verify()` for CI: it detects changed files from the PR diff, classifies test vs
source, and sets the exit code.

```bash
bun run gate/cli.ts --repo . --base <baseSHA> --head <headSHA> --min-mutation-score 0.75
```

Behavior by PR shape (verified end-to-end in the e2e run):

| PR shape | Result |
|---|---|
| source + test changed | full `verify()` → exit 0/1 on the combined `GateResult` |
| source changed, **no test** | **REJECT** (Principle 2: a fix must ship a regression test) |
| test-only change | run the changed tests at head; pass if green (full gate N/A) |
| no gate-relevant files | SKIP (pass) |

In GitHub Actions it writes a step summary and `::error::` annotations. The workflow lives at
[`.github/workflows/verification-gate.yml`](../.github/workflows/verification-gate.yml) — check out
with `fetch-depth: 0` (the gate diffs and worktrees base↔head), `bun install` first (worktrees
symlink `node_modules`), then invoke the CLI with the PR's base/head SHAs. Adjust `--test-cmd` and
`--min-mutation-score` to your project; wire `--min-mutation-score` to the per-class effective bar
from the Trust Controller once that's live.

## Swapping in production engines

The drivers are references (string-mutation, git-worktree overlay); the **decision layers**
(`combineGate`, `scoreGate`, `mustFailOnParent`, `noWeakening`) are production-shaped and unit-tested.
Replace the mutation driver with StrykerJS and the test driver with your CI runner — `combineGate`'s
contract and the `GateResult` the router consumes are unchanged.
