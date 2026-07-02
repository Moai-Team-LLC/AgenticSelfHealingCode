# Verification Gate (spec)

> **Reconciliation note.** `ARCHITECTURE-REFRAMED.md` is the source of truth for cross-component
> contracts and overrides this file where they differ. Superseded here: the diff-stacking guard is a
> net-new **"churn escalator"**, *not* "attack #11" (STRESS-TEST has only #1–#9) — owned by
> `TRUST-CONTROLLER.md §4.1` (keystone §2); the gate does **not** write `auto_action` rows
> (`ORCHESTRATION.md`'s apply-time writer does), and churn is fed from the `auto_action` table, not the
> gate-result stream (keystone §2/§3.2); the effective `requiredMutationScore` is sourced from
> `trust_controller.yaml` via the router — the gate keeps only a hard floor fallback (keystone §2).

The automated verification layer that gates **every** machine-authored change before a
human sees it. Gates Loop B heals today (see LOOP-B-SPEC.md) and Loop C production-code
fixes later (deferred; see ARCHITECTURE-REFRAMED.md). It is deliberately dumb about
narrative and smart about signals: correctness here is decided by mechanical, non-LLM
evidence, not by anyone's story about the change — including the change author's own.

The gate is **per-change and stateless** — a pure function of one `(parentSHA, fixSHA)`
pair plus the tier it is handed. It does **not** own autonomy tiers, does **not** decide
trust, and does **not** track cross-run history. Those belong to TRUST-CONTROLLER.md,
which hands this gate an already-resolved `(loop, tier)` and consumes the gate's signals.
Keeping the two apart is deliberate: two components independently mutating tier is
split-brain, and neither's audit log would be authoritative for "who moved it there."

Cross-cutting invariants (per ARCHITECTURE-ORIGINAL.md §12): every gate run emits a
replayable why-trace, honors the kill switch (freeze → the gate still evaluates and
records but blocks *every* downstream action — no auto-apply, no PR-open, no HITL ping;
§7), and appends to the immutable audit log. Stack: TS-native (Claude Agent SDK),
Postgres+pgvector, GitHub Actions CI, Telegram HITL bot.

---

## 1. Purpose & where it sits

```
change proposed (Loop B heal candidate | Loop C fix candidate)
  + resolved (loop, tier) from TRUST-CONTROLLER.md
  + requiredMutationScore + accountabilityOwner (for auto columns)
        │
        ▼
┌─────────────────────────────────────────────────────────┐
│                   VERIFICATION GATE                       │
│                                                           │
│   Signal battery (non-LLM, load-bearing) ──► GateResult   │
│      full suite · types · lint · static analysis          │
│      MUST-FAIL-ON-PARENT   MUTATION SCORE   no-weakening   │
│      reversibility probe · diff-vs-class-budget SIGNAL     │
│                                                           │
│   Judge-agent (LLM) reads the SIGNALS + diff, not the     │
│      RCA narrative alone ──► advisory veto only           │
└─────────────────────────────────────────────────────────┘
        │ PASS                              │ FAIL
        ▼                                   ▼
  Loop B: heal committed in author's PR     leave red / discard candidate,
  Loop C: PR opened for HITL (never          attach GateResult to why-trace,
          auto-merge in v1)                  route to human with reason
```

The gate runs inside the ephemeral sandbox (clean repo clone, least-privilege service
account, egress-controlled — ARCHITECTURE-ORIGINAL.md §6, STRESS-TEST.md #7 / D7). It
never touches prod. Nothing downstream — no PR, no HITL bot ping, no auto-merge — fires
unless the gate returns `PASS` for the required signal set of that change's tier/loop
(§5) **and** the kill switch is not engaged.

**Independence principle (D8).** The gate's authority comes from signals that are
*causally independent of the model that wrote the change*: a mutation testing tool, a
static analyzer, and a must-fail-on-parent re-run share no blind spots with the fix
author. A second LLM prompt of the same model family does not — it fails the same way
on the same confidently-wrong inputs. The judge-agent (§4) exists, but it is fed the
signal evidence and is advisory; it is never the thing that clears the gate. This
directly closes attack #4 (agent grades its own homework) and #8 (judge
non-independence).

**What the gate does NOT defend (explicit non-goals).**
- **Tier assignment / autonomy expansion** — owned by TRUST-CONTROLLER.md. The gate
  reports the diff-vs-class-budget *signal* (§5); the controller acts on it.
- **Attack #11 (cumulative same-area churn / diff-stacking)** — the gate is stateless and
  sees exactly one change; three separate small green fixes stacking into one module over
  an hour each pass S1–S8 individually. Diff-stacking is caught by the *area-keyed,
  windowed churn escalator* in TRUST-CONTROLLER.md §4.1, which consumes the per-run
  `moduleArea` / `diffLines` fields the gate emits in `GateResult`. The gate is **not**
  the last line of defense against #11 and does not pretend to be.

---

## 2. The signal battery (D8)

Each signal is a pure function `(parentSHA, fixSHA, moduleArea, testId?) → SignalResult`
run in the sandbox, producing a grounded boolean plus evidence. All are non-LLM except
the judge (§4). Ordered cheap-first. **Only load-bearing signals short-circuit** on a
hard `FAIL` (S1, S3–S8): a hard FAIL there ends the run early. Advisory signals (S2, and
the judge S9) **never** short-circuit — they always run to completion and only annotate
the result.

```ts
interface SignalResult {
  signal: string;                 // e.g. "must_fail_on_parent"
  pass: boolean;                  // grounded boolean; for advisory signals, informational
  evidence: Record<string, unknown>;
  reason: string;                 // human-readable, points at the grounded fact
}
```

| # | Signal | Kind | Produces | Load-bearing? |
|---|---|---|---|---|
| S1 | Build / typecheck (`tsc --noEmit`) | non-LLM | compiles: bool | yes (gate to run rest) |
| S2 | Lint (`eslint`, repo config) | non-LLM | clean: bool, findings[] | no (advisory) |
| S3 | Full test suite on fixSHA | non-LLM | all green: bool, failing[] | yes |
| S4 | **Must-fail-on-parent** | non-LLM | valid regression: bool | **yes — anchor** |
| S5 | **Mutation score on touched module** | non-LLM | score ≥ required: bool | **yes — anchor** |
| S6 | No-weakening guard | non-LLM (AST) | not weaker: bool | yes |
| S7 | Static / security analysis (semgrep) | non-LLM | clean: bool, findings[] | yes (secrets/unsafe) |
| S8 | Reversibility probe | non-LLM (§6) | side-effect-free: bool | yes for auto-apply |
| S9 | Judge-agent | LLM | advisory veto + reasons | no (advisory only) |

The two load-bearing NON-LLM gates — S4 and S5 — are the reason the gate can be trusted
at all. They are specified in full below.

### 2.0 Module scope (used by S5, churn, and the class key)

Several signals need "the touched module." It is defined once, here, so the gate and
TRUST-CONTROLLER.md agree on granularity (they must — the controller keys its class and
its churn counter on the same unit):

```
moduleArea := repo-relative directory of the diff at fixed depth (default depth 2,
              e.g. "src/checkout"), the SAME key TRUST-CONTROLLER.md §2.1 uses.

touchedModules (S5 mutation scope) := the set of files in the diff
              PLUS their direct in-package reverse-dependency call sites
              (files in the same package that import a changed export).
```

Reverse-dependency inclusion closes the obvious dodge (edit `a.ts` whose real risk is in
`b.ts`, which imports the changed export from `a.ts`, and mutation-score only `a.ts`).
`moduleArea` is emitted verbatim in `GateResult` so the churn escalator keys on the same
place the gate saw.

### S1–S3 — the table stakes

- **S1 build/typecheck.** `tsc --noEmit` on `fixSHA`. A change that doesn't compile is
  discarded immediately; if it's a Loop B red test caused by a compile/import error, that
  is class D (broken-infra) and is routed to build-fix, not treated as a heal
  (LOOP-B-SPEC.md step 1).
- **S2 lint.** Repo ESLint config. Findings are advisory (attached to the why-trace and
  fed to the judge), not a hard gate, and never short-circuit — style noise must not block
  a correct fix.
- **S3 full suite.** The **entire** suite on `fixSHA`, never only the touched test
  (ARCHITECTURE-ORIGINAL.md §7). Catches side-effect breakage the author didn't intend.
  Any red here that is *not* the test being healed = hard FAIL.

### S4 — MUST-FAIL-ON-PARENT (D4)

The single cheapest defense against a vacuous test (attack #4). A regression/heal test
that passes on the pre-change code tests **nothing** — it merely asserts that the new
code does what the new code does.

Rule: the regression test (Loop C) or the healed test (Loop B) **MUST fail on the parent
commit for a value/behavior reason, and pass on the fix commit.**

Mechanic — run the *single* test against both SHAs in the sandbox, and distinguish a
genuine behavioral fail from a compile fail caused by symbols the fix newly introduces:

```ts
// signals/mustFailOnParent.ts
async function mustFailOnParent(
  ctx: SandboxCtx,
  parentSHA: string,
  fixSHA: string,
  testId: string,          // fully-qualified test identifier
): Promise<SignalResult> {
  // 1. check out parent, apply ONLY the test delta from the fix (not the src fix)
  await ctx.checkout(parentSHA);
  await ctx.applyTestOnly(fixSHA, testId);        // isolate: test change without src change

  // 1a. If the test references symbols the fix introduces, it CANNOT compile on parent
  //     by construction. Do NOT treat that as either "fail" (vacuous-catch) or "pass".
  //     Resolve new symbols to parent-behavior shims so the test can EXECUTE on parent,
  //     then judge it on the VALUE/BEHAVIOR outcome, not the compile outcome.
  const newSymbols = await ctx.symbolsIntroducedBy(fixSHA, testId); // exports/signatures new in fix
  if (newSymbols.length > 0) {
    await ctx.shimToParentBehavior(newSymbols);   // throwing shim for genuinely-new API;
                                                  // pre-fix impl for changed signatures
  }
  const onParent = await ctx.runSingleTest(testId); // expect: FAIL for a value/behavior reason

  // 2. check out full fix (src + test), run the same test
  await ctx.checkout(fixSHA);
  const onFix = await ctx.runSingleTest(testId);    // expect: PASS

  const parentFailedForBehavior =
    onParent.status === "fail" && onParent.failureKind !== "compile";
  const valid = parentFailedForBehavior && onFix.status === "pass";

  return {
    signal: "must_fail_on_parent",
    pass: valid,
    evidence: { parentSHA, fixSHA, testId, newSymbols,
                onParent: { status: onParent.status, kind: onParent.failureKind },
                onFix: onFix.status },
    reason: valid ? "test discriminates the change"
      : onParent.status === "pass"
        ? "test passes on parent → tests nothing (vacuous), REJECT"
        : onParent.failureKind === "compile"
          ? "test fails to compile on parent even after shimming new symbols → inconclusive, route to human"
          : "test does not pass on fix → not a valid green",
  };
}
```

Notes:
- **Test delta isolated from src delta.** On the parent we apply *only* the test change,
  not the source fix, so a behavioral `fail` there proves the test genuinely depends on the
  changed behavior — not that the test happens to reference a symbol that doesn't exist yet.
- **New public API is a first-class case, not a force-route.** A large, legitimate class of
  fixes introduces a new public symbol/signature the regression test must reference; such a
  test can *never* compile on parent verbatim. We resolve those new symbols to
  parent-behavior shims (a throwing shim for genuinely-new API; the pre-fix implementation
  for a changed signature) so the test **executes** on parent and is judged on its
  value/behavior outcome. This keeps S4 passable for new-API fixes — including in the
  auto-apply column — instead of leaving a permanent capability hole.
- **Residual limitation (stated, not buried).** If a test *still* fails only to compile on
  parent after shimming — i.e. the change is so structural that no parent-behavior shim
  exists (e.g. a symbol removed, a type reshaped such that the old call site is
  ill-typed) — S4 is `inconclusive → FAIL` and the change is routed to a human. For Loop C
  auto-apply this means: a fix whose regression test cannot be made to execute against
  parent-behavior is never auto-applied. This is a known, bounded exclusion, not a silent
  one.
- This is exactly LOOP-B-SPEC.md guard 1 ("exercises the change") generalized to Loop C
  and made a hard gate rather than an optional check.
- Loop C corollary (D4): every fix ships with a regression test satisfying S4. A fix with
  no test that fails-on-parent-for-behavior cannot pass the gate — no exceptions.

### S5 — MUTATION SCORE on the touched module (D4)

Line/branch coverage answers "was this line executed," which a vacuous test satisfies
trivially. **Coverage is rejected as the strength gate.** The real question — "is the
suite strong enough that a wrong change to this module would be *caught*" — is answered
by mutation testing: inject small faults (mutants) into the touched module and measure
how many the suite kills.

- **Tooling:** StrykerJS (`@stryker-mutator/core`) for TS. Configured to mutate **only
  the `touchedModules` set** (§2.0) of the change (perf: full-repo mutation is too slow
  for gate latency), running against the suite on `fixSHA`.
- **Metric:** mutation score = killed / (killed + survived), excluding no-coverage and
  compile-error mutants from the denominator per Stryker defaults, but surfacing
  `noCoverage` count separately (a high no-coverage count is itself a weak-suite signal).
- **Threshold ownership.** `verification.yaml` holds a **hard floor** — a class may never
  auto-apply below it, full stop. But the *effective* score required for a given change's
  column is **supplied by TRUST-CONTROLLER.md at call time** (`requiredMutationScore` in
  the gate input). The gate must not itself decide "strong enough for auto-apply": that is
  the same split-brain as tier ownership (§1). A class the controller has not earned into
  an auto column cannot pass the auto column regardless of `verification.yaml`. The gate
  fails S5 if `mutation_score < max(floor, requiredMutationScore)`. This is the D4
  "suite strong enough" gate and the operational form of principle 6 (garbage in →
  garbage out): a weak module never qualifies its changes for auto-apply, permanently, not
  as a one-time phase gate.

```yaml
# verification.yaml
mutation:
  runner: strykerjs
  scope: touched_modules            # never whole-repo in the gate (see §2.0)
  floor:                            # HARD minimum; controller supplies the effective bar
    auto_apply: 0.75                # gate refuses any auto column below this, always
    human_gated: 0.60              # a human is the backstop for gated tiers
  timeout_per_module_s: 240
  on_timeout: fail                  # slow ≠ pass; escalate to human
  surface_no_coverage: true
```

Interaction with S4: S4 proves *this* test discriminates *this* change; S5 proves the
*surrounding suite* is strong enough that the module isn't a soft target. Both are
required because each covers the other's gap — a strong module with a vacuous new test
(S4 catches), a discriminating test in an otherwise-untested module (S5 catches).

---

## 3. No-weakening guard (S6)

Generalized from LOOP-B-SPEC.md guard 2. A heal or fix must not silently loosen a guard.
The failure mode: `assert x === 90` "healed" to `assert x != null` — the test still
passes S4 (fails on parent where x was undefined, passes on fix) but now accepts a
strictly larger set of behaviors. The guard was disabled, not updated. Because a test's
blast radius is temporally unbounded (LOOP-B-SPEC.md preamble), this is more dangerous
than a bad prod fix.

**Rule:** reject/flag if the set of behaviors the new assertion *accepts* is a **superset**
of the set the old assertion accepted.

Decision procedure (AST-level, non-LLM, best-effort with safe fallback):

```
For each assertion changed in the diff:
  old_shape := classify(old_assertion)   # equality | membership | comparison | truthiness | shape
  new_shape := classify(new_assertion)

  WEAKER if any of:
    - equality  → truthiness / not-null / typeof / "defined"      (exact → loose)
    - equality on value → comparison with wider range              (x==90 → x>=0)
    - membership(specific) → membership(broader) / any             (["a"] → contains a)
    - shape(deep) → shape(partial) / property-existence-only       (deepEqual → hasProperty)
    - assertion removed entirely / replaced by a no-op / toBeTruthy on a formerly-typed value
    - expect().toThrow(SpecificError) → toThrow() with no matcher

  If WEAKER          → FAIL (Loop B: escalate to review even WITH author approval;
                             Loop C: hard block).
  If shape unclassifiable (custom matcher, complex expr) → FLAG inconclusive
                             → route to judge (§4) + human note, never silent pass.
  Else               → PASS.
```

Loop C generalization: the same guard applies to *any* assertion the fix touches, not
only in the fix's own regression test — a fix that edits an unrelated existing test to
make it pass is exactly scope creep + guard-weakening and must be caught here and by the
judge (§4).

---

## 4. The judge-agent

The judge is an LLM pass (Claude Agent SDK). It has a **real** job and a **hard limit**,
and confusing the two is attack #8.

**Right role — things signals don't cleanly express, expressed as evidence review:**
- **Scope creep** — diff touches files/symbols unrelated to the stated fix scope.
- **Hardcoded secrets / credentials** — corroborating S7 (semgrep), not replacing it.
- **Unsafe patterns** — `eval`, shelling out with interpolated input, disabled TLS
  verification, `// eslint-disable` hiding a real finding, broadened error swallowing.
- **RCA-vs-diff mismatch** — the diff does not plausibly implement what the RCA claims
  (a fix labeled "null-check" that also rewrites a query, etc.).

**Hard limit (D8, attack #4/#8).** The judge is **not** independent verification. It
shares a model family — and therefore blind spots — with the change author. A confidently
wrong RCA narrative *primes* a same-family judge to bless a fix that matches the wrong
story. Therefore:

1. The judge is fed **EVIDENCE, not narrative-alone.** Its primary inputs are the signal
   results (S4 must-fail outcome, S5 mutation score + surviving mutants, S6 weakening
   verdict, S7 findings) plus the raw diff. The RCA narrative is provided **only** as a
   *claim to be checked against the diff*, explicitly labeled untrusted, never as the
   ground truth.
2. The judge's verdict is **advisory** and can only *veto* (add a blocking reason for
   human review) — it can **never upgrade** a change that failed a load-bearing non-LLM
   signal (S4/S5/S6/S7/S8) into a pass. A green judge on top of a red S4 is still a FAIL.
3. The judge **cannot see** anything that would let it launder a story into a pass: no
   self-reported LLM confidence from the author (D3), no "the author says this is fine."

**Judge input contract:**

```ts
interface JudgeInput {
  diff: UnifiedDiff;                         // the actual change, primary artifact
  changedAssertions: AssertionDelta[];       // from S6, with weaker/ok/unclear labels

  signals: {
    mustFailOnParent: { pass: boolean; onParent: "pass"|"fail"|"inconclusive"; onFix: "pass"|"fail" };
    mutation: { score: number; required: number; killed: number; survived: MutantDesc[]; noCoverage: number };
    weakening: { verdict: "ok"|"weaker"|"unclear"; details: string[] };
    staticAnalysis: { findings: SemgrepFinding[] };   // rule id, severity, location
    fullSuite: { green: boolean; failing: string[] };
  };

  scope: {
    declaredScope: string;                   // e.g. "null-check in src/pricing/quote.ts"
    filesTouched: string[];
    symbolsTouched: string[];
  };

  // Provided ONLY as an untrusted claim to check against `diff`. NOT ground truth.
  rcaClaim: { hypothesis: string; fixClass: "code"|"config"|"infra"|"data" } | null;

  meta: { loop: "B"|"C"; tier: 1|2|3|4; parentSHA: string; fixSHA: string };
}

interface JudgeVerdict {
  vote: "no_objection" | "veto";
  reasons: Array<{
    kind: "scope_creep"|"secret"|"unsafe_pattern"|"rca_diff_mismatch"|"weakening_echo";
    detail: string;
    evidenceRef: string;                     // points at diff hunk or signal, never at RCA prose
  }>;
  // No "confidence" field — self-reported confidence is disallowed (D3).
}
```

The judge's prompt is constructed so that the diff and signals precede the `rcaClaim`,
and the `rcaClaim` is wrapped as untrusted-input (same posture as telemetry text in D7):
it may inform *what to check* but may never be cited as *why something is fine*.

---

## 5. Pass/fail policy

The gate receives a **resolved `(loop, tier)`** from TRUST-CONTROLLER.md and selects its
required-signal column from that tier. It does **not** move the tier. A change `PASS`es
only if it clears **every required** signal for its handed column. Any hard signal
`FAIL` = gate FAIL. Judge veto never overrides a hard FAIL and never upgrades one; a judge
veto on an otherwise-passing change routes it to a human with the veto reason (does not
silently discard).

Legend: R = required (hard gate) · A = advisory (attached, judge-fed, non-blocking) ·
— = n/a.

| Signal | Loop B: flaky quarantine (autonomous) | Loop B: test heal (human-gated PR) | Loop C: PR (HITL, v1) | Loop C: auto-apply (deferred, earned) |
|---|---|---|---|---|
| S1 build/typecheck | R | R | R | R |
| S2 lint | A | A | A | A |
| S3 full suite green | R | R | R | R |
| S4 must-fail-on-parent | — (no assertion added) | **R** | **R** | **R** |
| S5 mutation ≥ required | — | R (`≥ effective`) | R (`≥ effective`) | **R (`≥ max(floor, requiredMutationScore)`)** |
| S6 no-weakening | — (adds no assertion) | **R** | R | R |
| S7 static/security | A → **scope check** | R | R | R |
| S8 reversibility probe | — (no code change) | — (test-only, in PR) | R (must be provable) | **R (hard, §6)** |
| S9 judge-agent | A | A | R (veto→human) | R (veto→human) |
| `accountabilityOwner` present | — | — | — | **R (hard-FAIL if null)** |
| Human approval after gate | not required¹ | **required** (author, PR-time) | **required** (HITL, D9 owner) | not required² |

¹ Flaky quarantine ships autonomously (LOOP-B-SPEC.md): it asserts *no* behavior, so
  S4/S5/S6/S8 are n/a; it still runs S1/S3 and opens a low-pri evidence PR. S7 on a
  tag-only diff cannot meaningfully introduce a secret or unsafe pattern, so it is **not**
  a hard behavior gate here; instead it degrades to a **scope check**: a "quarantine" diff
  that touches anything *other* than the quarantine tag / skip-list is out of scope and is
  FAILed (a quarantine PR sneaking a non-tag edit is exactly the thing to catch). Guard:
  quarantine rate cap lives in TRUST-CONTROLLER.md §4, not here.

² Loop C auto-apply is **deferred** and only ever unlocked per-incident-class by
  TRUST-CONTROLLER.md on measured outcome data (D5, D6, D10), business-hours,
  proven-reversible. When/if unlocked, the gate requirements above are the *floor*, and
  the gate **hard-FAILs the auto column if `accountabilityOwner` is null** — the gate does
  not source the owner, it *requires* one in its input (D9), making the owner an
  enforceable precondition rather than a decorative log line. Until the controller returns
  an L3 (auto) tier for the class, this column is unreachable — the gate hard-refuses
  auto-apply for Loop C regardless of signal state.

**Diff-vs-class-budget is a SIGNAL, not a decision.** The gate does not auto-escalate a
tier. It measures the diff against the class's declared size budget and emits the result
as fields on `GateResult` (`declaredFixClass`, `diffLines`, `exceedsClassBudget`) plus
`moduleArea`. TRUST-CONTROLLER.md (which owns tier and the churn escalator, §4.1) consumes
those fields and decides any escalation. The gate simply evaluates whatever column it was
handed.

---

## 6. Reversibility check (S8)

Attack #9 / D2: "a revert commit is ready" is **not** a rollback if the change had
side effects. A revert of the *code* does not un-run a migration, un-send a webhook, or
un-write a row. Nothing may be *classed reversible* (and therefore auto-appliable) until
its module is attested side-effect-free **and** the change passes the mechanical probe.

Static "does this diff introduce a side effect" is, in general, undecidable — one
indirection (a call through a variable, a wrapper util, dynamic dispatch, a transitive
dependency) defeats pure AST diffing, and egress-deny corroboration only sees the sinks
the regression test happens to exercise, so a side effect on an untested branch is
invisible. We therefore do **not** claim to *prove* an arbitrary diff side-effect-free.
Instead S8 is a **positive-attestation gate plus best-effort corroboration**:

```
S8 PASS (reversible = true) requires ALL of:

0. POSITIVE ATTESTATION (the real gate).
   - Every file in the diff is on the repo's `side_effect_free_modules` allowlist
     (verification.yaml). These modules are human-audited as pure / side-effect-free and
     re-audited when their allowlist entry's pinned hash drifts. Auto-apply is confined to
     this positively-attested surface — NOT inferred from a clean diff.

1. No schema/data migration touched.
   - diff touches no path in migration globs (**/migrations/**, drizzle/**, prisma/migrations/**)
   - AND no call to migration/DDL APIs introduced (ALTER/CREATE/DROP, db.schema.*, raw DDL)

2. No external write introduced — BEST-EFFORT, corroborating, not proof.
   - static: no NEW call sites to known egress/side-effecting sinks vs parent —
     outbound HTTP (fetch/axios to non-allowlisted host), queue publish, email/SMS send,
     payment API, file write outside sandbox tmp, cache/state mutation with no inverse.
   - sandbox corroboration: run the fix's regression test with egress DENY (D7 egress
     control). If it attempts a blocked external write, it is NOT side-effect-free → FAIL.
   - LIMITATION (explicit): clause 2 catches sinks on exercised paths and known-shape call
     sites only. Residual side-effect risk on unexercised paths is accepted ONLY because
     clause 0 already confined the change to a pre-attested side-effect-free module. Clause
     2 is a tripwire on top of the attestation, not a substitute for it.

3. Diff stays within revertible surface.
   - all touched paths are ordinary source (not infra-as-code, not secrets, not CI config —
     these are protected and never auto-apply anyway per §5 / ARCHITECTURE-ORIGINAL.md §12).

4. A revert commit is prepared AND applies cleanly against current HEAD in sandbox
   (necessary, not sufficient — this is the weakest of the checks, listed last).

reversible := (0) ∧ (1) ∧ (2) ∧ (3) ∧ (4)
```

If `reversible = false`, S8 FAILs for any auto-apply column; the change can still proceed
as a **human-gated PR** (a human accepts the irreversibility knowingly), never as
auto-apply. Loop B test heals are inherently test-only and touch no prod side-effect
surface, so they satisfy S8 trivially — but they remain human-gated for the *intent*
reason (LOOP-B-SPEC.md), not the reversibility reason.

The probe result (which of 0–4 failed, with the offending call site / migration path /
non-attested file) is recorded in the why-trace and shown to the human on any escalation,
so "why wasn't this auto-applied" is always answerable from the audit log.

This is the action-time check for the L3 hard-gate TRUST-CONTROLLER.md §3.5 refers to
("proven side-effect-free … checked by the Verification Gate"). A gate FAIL here escalates
*this action*; it does not by itself demote the class — repeated failures feed the
controller's circuit breaker (TRUST-CONTROLLER.md §4.2).

---

## 7. Kill switch behavior

Freeze is not "block auto-apply" — it is **diagnosis-only for the whole network**
(ARCHITECTURE-ORIGINAL.md §12 principle 5; TRUST-CONTROLLER.md §5 forces every class's
effective level to L0). Opening a Loop B or Loop C PR and pinging the HITL bot are
downstream *actions* that mutate a repo or create a review artifact — they are not
diagnosis, so freeze must stop them too.

On freeze, the gate:
1. still **evaluates and records** the full battery (bookkeeping is never frozen — the
   why-trace and audit log are written normally),
2. returns `frozen: true`, `pass: false`, `blockedReason: "frozen"`,
3. blocks **every** downstream action — auto-apply, PR-open, and HITL ping alike,
4. escalates to a human as `frozen` (a status the operator sees), never by opening a
   review artifact.

Diagnosis-only therefore means: evaluate + record + surface-as-frozen, and nothing that
mutates a repo or opens a review.

---

## Attacks explicitly defended

- **#4 — agent grades its own homework.** S4 (must-fail-on-parent, distinguishing genuine
  behavioral fail from new-symbol compile fail) makes a vacuous self-confirming test fail
  the gate: a test that passes on parent is rejected as testing nothing. S5 (mutation)
  makes a weak module fail regardless of a green suite. The clear signal is non-LLM and
  shares no blind spot with the author (D8).
- **#8 — judge non-independence.** The judge is advisory-only, cannot upgrade a
  load-bearing FAIL, and is fed **evidence** (signals + diff) with the RCA narrative
  demoted to an untrusted claim-to-check (§4). Independence lives in the signal battery
  (S4/S5/S6/S7/S8), never in a same-family second prompt (D8).

Explicitly **out of scope** for this gate (owned elsewhere, stated so no reader assumes
last-line-of-defense): tier assignment and autonomy expansion (TRUST-CONTROLLER.md); and
**#11 — diff-stacking / cumulative same-area churn**, which the gate cannot see because it
is per-change and stateless — defended by the area-keyed churn escalator in
TRUST-CONTROLLER.md §4.1, fed by this gate's per-run `moduleArea` / `diffLines`.

## Interfaces & files

- `verification.yaml` — mutation floor, reversibility globs, `side_effect_free_modules`
  allowlist (§2, §5, §6). Effective mutation bar and tier come from TRUST-CONTROLLER.md at
  call time, not this file.
- **Consumes:** sandbox from ARCHITECTURE-REFRAMED.md (clean clone, least-privilege SA,
  egress control — D7); per-test-per-commit CI results (LOOP-B-SPEC.md inputs,
  ARCHITECTURE-ORIGINAL.md §16); and per call: `{ parentSHA, fixSHA, loop, tier,
  requiredMutationScore, accountabilityOwner? }` handed down by TRUST-CONTROLLER.md.
- **Produces:**

```ts
interface GateResult {
  pass: boolean;
  frozen: boolean;                 // kill switch engaged → evaluated + recorded, ALL
                                   //   downstream actions blocked (auto-apply, PR-open, HITL ping)
  loop: "B" | "C";                 // echoed back for audit
  tier: 1 | 2 | 3 | 4;             // echoed back; NOT chosen here
  signals: SignalResult[];         // one per S1..S8 run (see §2)
  judgeVerdict: JudgeVerdict | null;
  reversible: boolean;

  // consumed by TRUST-CONTROLLER.md (§4.1 churn, tier decisions) — the gate reports, does not act
  moduleArea: string;              // §2.0, same key the controller uses
  declaredFixClass: string;
  diffLines: number;
  exceedsClassBudget: boolean;

  // present when the gate refused an auto path
  blockedReason?: "auto_apply_blocked" | "frozen" | "missing_accountability_owner";
  whyTraceId: string;
}
```

  appended immutably to Incident Memory (INCIDENT-MEMORY.md; ARCHITECTURE-ORIGINAL.md §10)
  and gating the HITL bot / auto-merge decision.
- **Honors kill switch:** on freeze, the gate returns `frozen: true` with every downstream
  action blocked — auto-apply, PR-open, and HITL ping — leaving diagnosis-only mode (§7;
  matches TRUST-CONTROLLER.md §5 forcing effective L0).
