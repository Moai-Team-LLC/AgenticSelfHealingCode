# Loop B — Test-Suite Self-Healing (spec)

Runs on the test suite, never on prod. Split by **autonomy-safety**, because the
three jobs have very different blast radii. A bad prod fix causes one localized
incident; a bad *test* edit silently weakens a guard protecting every future change
through that path — temporally unbounded blast radius. Autonomy is granted inversely
to that radius.

| Job | Blast radius | Autonomy | Ships |
|---|---|---|---|
| Flaky quarantine | ~zero (marks non-determinism, asserts no behavior) | **Autonomous** | v1 |
| Test healing | unbounded (a wrong heal disables a guard forever) | **Human-gated, PR-time author-assist** | v1 |
| Coverage gaps | low (additive; can't disable an existing guard) | Autonomous low-pri PR | later |

---

## The core problem: (a) regression vs (b) stale test

A test goes red after a code change C. Four classes:

- **A — legitimate regression.** C broke real behavior. Action: leave red, alert. NEVER auto-edit the test.
- **B — stale test.** C deliberately changed behavior/interface; the test encodes the old expectation. Action: heal *candidate* (human-gated).
- **C — flaky.** Non-deterministic. Action: auto-quarantine.
- **D — broken infra.** Compile error, missing fixture, import. Action: route to build-fix, not healing.

The dangerous confusion is A vs B — both present as "test red after a change touching
related code." A naive "does the new assertion pass on new code?" check is circular: it
confirms the assertion changed, not that the new behavior is *correct*. The correct
discriminator uses grounded signals plus the one true oracle of intent — the human who
made the change.

## Discriminator (decision procedure)

```
On test T red after change C:

1. Did T actually run? (compile/import/fixture failure)
   → class D (broken-infra). Route to build-fix. STOP.

2. Non-deterministic? Re-run T ×N (e.g. 5) on unchanged HEAD.
   - inconsistent pass/fail → class C (flaky).
       Auto-quarantine: add @flaky/skip tag CI respects + open low-pri PR.  [AUTONOMOUS]
   - consistent fail → continue.

3. Failure mode?
   - crash / throw / timeout (not a value assertion) → class A (regression).
       Leave red, alert human.  [NEVER heal — crashes are ~never "stale test"]
   - clean assertion value-mismatch (expected X, got Y) → continue.

4. Does T cover code OUTSIDE C's diff? (T broke as a side-effect)
   → class A (regression): C broke something it didn't mean to touch.
       Leave red, alert.  [NEVER heal — highest-signal regression indicator]

5. T covers code INSIDE C's diff → AMBIGUOUS (A vs B). Do NOT auto-decide.
   → class B-candidate. Emit PR-time prompt to C's author:
       "Change C broke T. T asserts <old>. New code yields <new>.
        Delta class: {rename | signature | format | value-logic}.
        Intended change? [heal to <new>]   [this is a regression, I'll fix]"
   Author confirms heal → agent applies the assertion update IN THE SAME PR.  [HUMAN-GATED]
```

Rationale for the shape:
- **The author is the intent oracle.** Healing triggers at *PR time* for the author who
  made C, not autonomously post-merge. The human who holds the intent stays in the loop
  cheaply; the agent does the tedium (which tests, why, proposed assertion).
- **Step 2 before 3/4** so flakiness never masquerades as a regression.
- **Step 4 is the strongest cheap signal:** a break in code C didn't touch is a
  side-effect regression, full stop — never a heal.
- **Delta class** informs the author: a rename/format break is a far safer heal than a
  value-logic break where the computed number changed.

## Guards on an approved heal (post-confirmation, non-LLM)

Even after the author says "heal it," verify mechanically:

1. **Exercises the change.** Original T *failed* on C and healed T *passes* on C — proves
   the test actually touches the changed behavior and isn't now vacuous.
2. **No weakening.** Reject/flag if the new assertion is strictly weaker than the old
   (e.g. `assert x == 90` → `assert x is not None`). Heuristic: if the set of code
   behaviors the new assertion accepts is a superset of the old, the guard was loosened,
   not updated → escalate to review even with author approval.
3. **Discrimination preserved (optional, expensive).** Healed T still fails against a
   trivial mutant of C's new code — confirms the heal didn't collapse the test to
   always-pass.

## Flaky quarantine (autonomous) — detail

- Detection: re-run ×N on a fixed commit; flag if pass/fail is inconsistent OR if
  failure correlates with wall-clock/order/parallelism (order-shuffle a second batch).
- Action: tag `@flaky`, CI treats as non-blocking, open a low-priority PR with the
  re-run evidence attached. Never silently delete.
- Safe to automate because a quarantine tag asserts *no behavior* — worst case is a real
  failure gets muted, which the evidence-PR surfaces for human triage.
- Guard: cap quarantines/week and alert if the flaky rate itself is climbing (could
  indicate a real intermittent regression, not test noise).

## Coverage gaps (later) — detail

- Prioritize by **traffic × incident-history**, not line %. A cold path at 0% coverage
  matters less than a hot path at 60%.
- Additive only: new test files / new cases; never edits an existing assertion (that's
  healing's job, human-gated).
- Autonomous low-priority PR, human reviews. Blast radius is low because a bad *new*
  test can't disable an existing guard — worst case is a useless or flaky addition,
  which the quarantine job later catches.

## Inputs / infra required

- CI that reports **per-test pass/fail keyed to a commit** (GitHub Actions, §16).
- Sandbox ability to run a **single test against an arbitrary commit** (parent, HEAD, C).
- The **diff of C + its PR/commit description** (the intent signal for step 5).
- A **quarantine mechanism** CI honors (tag or skip-list).
- PR-comment channel to prompt the author (same HITL bot as §8).

## v1 scope (honest MVP for Loop B)

Ship **flaky quarantine** (autonomous) + **PR-time heal-assist** (human-gated).
Defer coverage-gap generation — it's the lowest-ROI job (the parent doc says so in §9.2)
and matters most only on thin suites, where the whole self-healing premise is shakiest.
