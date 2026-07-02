# Decision Log (D1–D10)

ADR-style record for the ten decisions that fix the reframed Self-Healing Ops architecture. Each decision closes a specific stress-test attack (STRESS-TEST.md §1–§9) or a hidden decision (STRESS-TEST.md "Hidden decisions to settle"). Positions here are **resolved and binding**; the component specs (`LOOP-A-SPEC.md`, `LOOP-B-SPEC.md`, `VERIFICATION-GATE.md`, `INCIDENT-MEMORY.md`, `TRUST-CONTROLLER.md`, `SECURITY-THREATMODEL.md`, `D10-INSTRUMENT.md`) implement them and are named as owners. Where the coherence critic surfaced a seam that a keystone (`ARCHITECTURE-REFRAMED.md`, `ORCHESTRATION.md`, `HITL-APPROVAL.md`) must reconcile, it is called out under **Consequences**.

Status legend: **Accepted** (resolved, implemented) · **Accepted-conditional** (resolved, but a live capability is gated on a measured precondition) · **Deferred** (decided *not* to build in v1; earned later on data).

Numbering crosswalk used throughout (the coherence critic flagged three interchangeable schemes — this is the single canonical mapping; `ARCHITECTURE-REFRAMED.md` owns it):

| Loop | Autonomy level (Trust Controller) | Tier (ARCHITECTURE-ORIGINAL / Gate) | Meaning |
|---|---|---|---|
| A (RCA copilot) | L0 (read-only) | Tier 1 | diagnosis, zero write |
| B (test-heal, human-gated) / C (PR, HITL) | L1 (assisted) | Tier 2–3 | machine authors, human merges |
| B (flaky quarantine) | L2 (bounded autonomous merge) | — | narrow autonomous merge, tag-only |
| C (auto-apply, deferred) | L3 (autonomous, per-class) | Tier 4 | earned per incident class |

---

## D1: Reuse existing infra (no new runtime)

**Status:** Accepted

**Context.** ARCHITECTURE-ORIGINAL.md §10 ("reuse") and §11 ("pick one") are in tension: does orchestration and memory run on the infra we already operate (AgenticOps durable Postgres state machine; AgenticMind Postgres+pgvector), or on a new runtime (Temporal, LangGraph, a dedicated vector DB)? A self-healing system whose own operational surface is a new distributed runtime adds exactly the kind of unowned failure mode it exists to reduce.

**Options considered.**
1. New durable-execution runtime (Temporal) + dedicated vector store.
2. New agent framework (LangGraph) for orchestration.
3. Reuse AgenticOps Postgres state machine for orchestration + AgenticMind Postgres+pgvector for Incident Memory.

**Decision.** Option 3. Orchestration is the existing AgenticOps durable Postgres state machine; Incident Memory is AgenticMind Postgres+pgvector. No new runtime is introduced unless a specific, justified requirement forces it (none has surfaced).

**Rationale.** A new runtime is unearned ops load (STRESS-TEST.md D1). Postgres already gives durability, transactions, an append-only audit substrate, and pgvector retrieval in one system we run and back up. Fewer moving parts is itself a safety property for an autonomy system.

**Consequences.**
- INCIDENT-MEMORY.md and TRUST-CONTROLLER.md both build on AgenticMind Postgres — coherent today.
- The durable state machine that owns cross-async-HITL incident state, `notify_state` transitions, and tier-transition kill-switch guards is **ORCHESTRATION.md** (not yet written). It is load-bearing for D1 and must define the state machine on AgenticOps Postgres, not introduce a runtime.
- Owner: `ORCHESTRATION.md` (state machine), `INCIDENT-MEMORY.md` (pgvector store), `TRUST-CONTROLLER.md` (durable trust state).

---

## D2: Sandbox repro is mandatory for any auto-apply

**Status:** Accepted (the capability it gates, Loop C auto-apply, is itself Deferred — see D5)

**Context.** ARCHITECTURE-ORIGINAL.md §4 marked sandbox reproduction *optional*. STRESS-TEST.md §2 shows that without a reproduced-then-fixed observation there is no grounded confidence — and 0.9³≈0.42 means ungrounded end-to-end auto-repair is below coin-flip.

**Options considered.**
1. Sandbox repro optional; rely on suite-green + LLM confidence.
2. Sandbox repro mandatory for any auto-apply (Loop C).

**Decision.** Option 2. Any auto-applied change (Loop C, when earned) requires the sandbox to **reproduce the signal from actual repo state** and a must-fail regression test to flip green. This is the grounded-confidence source. No repro → no auto-apply, full stop.

**Rationale.** A forged or misattributed signal cannot manufacture a *grounded* reproduction (ties to D7 spoofing defense). Repro-then-flip is an observable boolean, not a narrative.

**Consequences.**
- Hard scope limit, stated in SECURITY-THREATMODEL.md §4.2 and D10-INSTRUMENT.md: the sandbox holds **schema DDL only, no prod data** (least-privilege, D7). Therefore **grounded repro exists only for incident classes reproducible without representative prod data.** Data-dependent classes are structurally ineligible for Loop C auto-apply and remain Loop A (copilot) forever. This is consistent with STRESS-TEST.md §1 (the auto-repairable set is a minority of a minority) — safe *and* narrow by construction, a scope limit not a gap.
- Owner: `VERIFICATION-GATE.md` §6 (S8 reversibility + repro as action-time gate), `SECURITY-THREATMODEL.md` §2.4/§4.2 (repro defeats spoof-into-repair; the no-prod-data limit).

---

## D3: Confidence = grounded booleans, never self-reported LLM confidence

**Status:** Accepted

**Context.** STRESS-TEST.md §2/§4: LLM self-reported confidence is ~uncorrelated with correctness. Any gate keyed on a model's asserted confidence is keyed on noise.

**Options considered.**
1. Threshold on the model's self-reported confidence score.
2. A second model rates the first model's confidence.
3. Confidence is a set of observable, grounded booleans: did the repro reproduce the signal? did the fix flip the must-fail test green? did the regression test fail on the parent commit?

**Decision.** Option 3. Confidence is grounded booleans only. Self-reported confidence may be *stored* for analysis but is **never gated on**.

**Rationale.** Only observable facts about the world (repro reproduced; test flipped) correlate with correctness. A booleanized confidence cannot be talked up by a confident-but-wrong narrative.

**Consequences.**
- LOOP-A-SPEC.md §4 grounds every confidence signal as a mechanical boolean (G2 is an occurrence-match fraction, not a model assertion; `null` not `true` when the model merely claims a thing).
- INCIDENT-MEMORY.md stores `confidence_selfreport` but never gates retrieval or maturation on it.
- VERIFICATION-GATE.md's `JudgeVerdict` has **no** confidence field by construction (§4).
- Owner: `LOOP-A-SPEC.md` §4, `VERIFICATION-GATE.md` §4, `INCIDENT-MEMORY.md` §3.

---

## D4: "Suite strong enough" = mutation score on the touched module; every regression/heal test must fail-on-parent

**Status:** Accepted

**Context.** ARCHITECTURE-ORIGINAL.md §6 used line/branch coverage as the "strong enough" gate. STRESS-TEST.md §1/§4: coverage answers "was this line executed," which a vacuous test satisfies trivially; and the repair worker "grades its own homework" when a generated test asserts the *new code's* behavior and passes vacuously.

**Options considered.**
1. Line/branch coverage threshold on the touched module.
2. Mutation score on the touched module + a hard non-LLM must-fail-on-parent gate on every regression/heal test.

**Decision.** Option 2. The strength gate is **mutation score** on the touched module (S5). Independently, every regression or heal test **must fail on the parent commit for a value/behavior reason and pass on the fix commit** (S4). Both are required; neither substitutes for the other.

**Rationale.** Mutation score answers the real question ("would a wrong change to this module be caught?"); must-fail-on-parent kills the vacuous-test attack (a test that passes on parent tests nothing). A strong module with a vacuous new test is caught by S4; a discriminating test in an untested module is caught by S5.

**Consequences.**
- VERIFICATION-GATE.md S4/S5 own this. S4 distinguishes a genuine behavioral fail from a new-symbol compile fail via parent-behavior shims (keeps new-public-API fixes gate-eligible; residual: a fix so structural that no shim exists is `inconclusive → route to human`). S5 mutates `touchedModules` (diff files + in-package reverse-dependency call sites) via StrykerJS.
- LOOP-B-SPEC.md guards 1 and 3 are the Loop-B instances of S4 and mutation-discrimination.
- Config seam (coherence critic MINOR #13): `verification.yaml` holds a **hard floor**; the **effective** `requiredMutationScore` per class is supplied by TRUST-CONTROLLER.md at call time. `trust_controller.yaml` must store the per-class effective bar — `ARCHITECTURE-REFRAMED.md` names the authoritative source.
- Owner: `VERIFICATION-GATE.md` §2 (S4, S5), `LOOP-B-SPEC.md` (guards).

---

## D5: Center of gravity = RCA copilot + test-suite healing (not autonomous production repair)

**Status:** Accepted-conditional (conditional on D10; Loop C is Deferred)

**Context.** STRESS-TEST.md §1 and "What survives": the original architecture pointed its center of gravity at reactive production auto-repair — a minority of a minority (most incidents are config/data/capacity/upstream that code-only workers can't touch; the safe-to-auto-fix zone is anti-correlated with the bug-existing zone). The doc's own §9.2 named where the value is: test-suite self-healing.

**Options considered.**
1. Autonomous production-code repair as the v1 centerpiece.
2. RCA copilot (Loop A, Tier 1, zero write) + test-suite self-healing (Loop B) as the center; production auto-repair (Loop C) deferred and earned later.

**Decision.** Option 2.
- **Loop A** = RCA copilot: signal → dedup → RCA agent → grounded why-trace handed to the on-call human. Tier 1 forever, **zero** write access to app code. The v1 product.
- **Loop B** = test-suite self-healing (LOOP-B-SPEC.md): flaky quarantine (autonomous), test heal (human-gated PR-time author-assist), coverage gaps (later).
- **Loop C** = autonomous production-code repair: **Deferred**. Earned later, per-incident-class, on measured outcome data (D6), mutation-gated (D4), business-hours, proven-reversible (D2). Never architected first.

**Rationale.** ~80% of the value, ~10% of the risk sits in diagnosis + test-healing (STRESS-TEST.md). Loop B dodges attacks #1/#3/#6 because a human reads the test and blast radius is contained. Loop A dodges the write-path risk entirely.

**Consequences.**
- **Conditional on D10:** whether Loop A is built *now* vs deferred, and whether Loop C is *ever* earned, rests on the measured MTTR bottleneck (diagnosis vs remediation). D10-INSTRUMENT.md is the gate. Loop B is **verdict-independent** — it ships first regardless (D10-INSTRUMENT.md §6); do not read a Loop-B recommendation out of the D10 instrument.
- Owner: `LOOP-A-SPEC.md`, `LOOP-B-SPEC.md`, `D10-INSTRUMENT.md` (the conditionality). `LOOP-C-DEFERRED.md` (referenced, not yet written) owns the earn-later per-class policy.

---

## D6: Trust expansion is outcome-based, never human-override-rate alone

**Status:** Accepted

**Context.** STRESS-TEST.md §3: expanding autonomy by human-override rate is a positive-feedback runaway. Low override rate is ambiguous — "good fixes" and "nobody is checking" produce the identical metric. A weak suite passes subtly-wrong fixes green, damage surfaces slowly, nobody rejects at approval time, override reads low, the system expands into the classes it is worst at.

**Options considered.**
1. Expand autonomy when human-override rate is low.
2. Expand on an independent outcome signal: incident recurrence, new-incident-spawn in the touched module, later human revert.

**Decision.** Option 2. The trust controller is driven by **outcome signals** — did the incident recur within the window? did a new incident spawn in the touched module? was the fix later reverted by a human? — not by the absence of a veto. Override rate is at most a secondary, ambiguous input.

**Rationale.** Outcome signals are causally downstream of *correctness*, not of *attention*. They cannot be satisfied by nobody looking.

**Consequences.**
- TRUST-CONTROLLER.md owns promotion/demotion off the outcome event stream; only `verdict='matured'` resolutions are positive exemplars, caused-harm resolutions are labeled anti-patterns (closes the #8×#3 compounding path).
- INCIDENT-MEMORY.md maturation must survive the outcome window before minting `confirmed_good`.
- **Coherence critic BLOCKER #2:** maturation window must be `W_mature = max(W_recur, W_spawn, W_revert)` (TRUST-CONTROLLER.md §6.2), **not** `W_confirm=14d` (INCIDENT-MEMORY.md §5.3). The 14d job mints good while spawn/revert windows are still open — the exact boundary race. `ARCHITECTURE-REFRAMED.md` must delete `W_confirm` from Incident Memory and rebind maturation to `W_mature`; TRUST-CONTROLLER.md is the authority.
- **Coherence critic BLOCKER #3 / MAJOR #8 (the load-bearing gap):** the outcome data source requires `auto_action` rows for **both** `applied_by='machine'` (auto-apply) and `applied_by='human_approved'` (L1 human-merged heals — the `assisted_action` atom that bootstraps L1→L2). No component currently writes these rows, and INCIDENT-MEMORY.md sets `auto_action_id` NULL for human-merged PRs — contradicting TRUST-CONTROLLER.md's promotion ladder. `ARCHITECTURE-REFRAMED.md` must assign the writer (who inserts `auto_action` at auto-apply commit and at L1 PR merge) and extend INCIDENT-MEMORY.md's spawn/recurrence/revert attribution + harm query to cover both `applied_by` variants. Until fixed, D6 promotion is dead on arrival.
- Owner: `TRUST-CONTROLLER.md` (promotion off outcomes), `INCIDENT-MEMORY.md` (outcome detection, maturation), reconciled by `ARCHITECTURE-REFRAMED.md`.

---

## D7: Threat model in scope for v1 (signal auth, log-borne injection, sandbox egress, least-privilege)

**Status:** Accepted

**Context.** STRESS-TEST.md §7: this is an autonomous agent whose inputs originate with attackers and which (in Loop B/C) holds tools that write to the repository. No threat model existed. Real surface: signal spoofing (the attacker aims the agent), log-borne prompt injection → tool use (the RCA agent reads attacker-controlled telemetry), service-account blast radius (a write path to `main`).

**Options considered.**
1. Defer the threat model.
2. In scope for v1: authenticated signal ingestion; treat ALL telemetry text as untrusted input to the RCA agent; sandbox egress control; service-account least-privilege.

**Decision.** Option 2. In scope for v1:
- **Signal ingestion authenticated** (HMAC / mTLS, verify-before-normalize, source allow-list, rate-limit). Business-metric and browser-RUM signals can only open Loop A (read-only), never a write loop.
- **All telemetry text is untrusted** (log lines, stack traces, error messages, retrieved memory). The boundary is structural: the loop that reads untrusted text (Loop A) holds **zero write/exec tools** (per-loop static tool allow-list); write loops gate every action on grounded repro + human confirm. Telemetry is delivered as DATA, never as an instruction role. Taint-tracking is an audit signal, **not** a substring gate (a verbatim-substring gate is either bypassable or breaks normal RCA, and is a DoS surface).
- **Sandbox egress control** (deny-by-default allow-list; frozen-lockfile/offline install → zero registry egress; no prod reachability; no prod secrets).
- **Service-account least-privilege** (split identities per loop; server-side branch protection + a required path-diff status check, not CODEOWNERS-as-block; short-lived per-run tokens).

**Rationale.** Prompts are not a security boundary against inputs the attacker controls. Every mitigation is a server-side control. Even a fully-steered agent holding a legitimate least-privilege token bottoms out at a blocked, audited PR on a branch.

**Consequences.**
- SECURITY-THREATMODEL.md owns all of this (§2–§7) and is the concrete refutation of attack #7.
- D7 scopes the sandbox to no-prod-data, which is *why* D2's grounded-repro is limited to non-data-dependent classes — the two decisions are coupled.
- TRUST-CONTROLLER.md consumes D7 for blast-radius only; it does **not** own injection defense.
- D10-INSTRUMENT.md's optional `--llm-assist` is hardened under D7 (tool-less, enum-validated, untrusted-framed).
- Owner: `SECURITY-THREATMODEL.md`; consumed by `LOOP-A-SPEC.md`, `VERIFICATION-GATE.md`, `INCIDENT-MEMORY.md`, `D10-INSTRUMENT.md`.

---

## D8: Judge/verification independence comes from signals, not a second same-family prompt

**Status:** Accepted

**Context.** STRESS-TEST.md §4: the judge-agent that reads the diff *and the RCA narrative* shares a model family — and therefore blind spots — with the change author. A confidently wrong RCA primes a same-family judge to bless a fix matching the false story. A second prompt is not independent verification.

**Options considered.**
1. A second LLM prompt (possibly a different model) reviews the fix + RCA narrative and votes.
2. Independence comes from **signals** causally independent of the authoring model: mutation score, static analysis, must-fail-on-parent repro, diff-size-vs-class-budget policy. The judge exists but is advisory and fed evidence, never narrative-as-ground-truth.

**Decision.** Option 2. Verification authority lives in the non-LLM signal battery (VERIFICATION-GATE.md S4/S5/S6/S7/S8). The judge-agent (S9) is **advisory only**: it can veto (route to human) but can **never upgrade** a change that failed a load-bearing signal, and is fed the signal results + diff, with the RCA narrative demoted to an untrusted claim-to-check. Loop A has no judge at all — its independence is also structural (grounded booleans, no write sink).

**Rationale.** A mutation tool, a static analyzer, and a must-fail-on-parent re-run share no blind spots with the fix author. A same-family second prompt fails the same way on the same confidently-wrong inputs.

**Consequences.**
- VERIFICATION-GATE.md §4 defines the judge input contract (signals precede the untrusted `rcaClaim`; no confidence field, per D3) and §2 the load-bearing signal battery.
- LOOP-A-SPEC.md §4 explicitly states Loop A has no judge; independence comes from signals.
- Owner: `VERIFICATION-GATE.md` §2/§4.

---

## D9: A named accountability owner for any auto-merged outage

**Status:** Accepted

**Context.** STRESS-TEST.md §7/§9 and hidden-decision D9: without a named human owner, "who is accountable" is unanswerable at 3am, and the accountability requirement itself constrains which tiers may exist.

**Options considered.**
1. Post-hoc assignment after an incident.
2. A named owner is a **precondition on the existence** of any auto-merge tier — recorded per action, before the action.

**Decision.** Option 2. No auto-merge capability exists for an incident class without a named accountable engineer in its per-class policy. The owner is recorded per action, before merge (fail-closed: no audit append → no merge). Loop A records `handed_to` + the RCA trace id + grounding booleans (separating owner-of-action from diagnosis-that-informed-it). Loop B heals: `confirmed_by` (the PR author). Loop B quarantine: the standing Loop-B service owner.

**Rationale.** Accountability is only as real as the immutable audit chain that answers which signal, which hypothesis, which grounded-repro result, which policy version, who owns it, what the rollback plan was.

**Consequences.**
- **Coherence critic MAJOR #9:** the owner currently has four representations — `trust_class.owner` (TRUST-CONTROLLER.md §3.6, `check (level < 2 or owner is not null)`), gate-input `accountabilityOwner` (VERIFICATION-GATE.md §5, hard-FAIL if null on auto columns), `resolutions.merged_by` (INCIDENT-MEMORY.md), and `accountability.yaml` (SECURITY-THREATMODEL.md §6) — with no single source. `ARCHITECTURE-REFRAMED.md` must declare `trust_class.owner` authoritative and define the propagation path into the gate input and into `resolutions.merged_by`. The gate *requires* the owner in its input but does not source it (coherence critic MAJOR #7): the router that maps `AutonomyLevel → (loop, tier, requiredMutationScore, accountabilityOwner)` before calling the gate is owned by `ORCHESTRATION.md` + `ARCHITECTURE-REFRAMED.md` and must be defined.
- Owner: `TRUST-CONTROLLER.md` §3.6 (authoritative `trust_class.owner`), enforced at `VERIFICATION-GATE.md` §5, propagated via `ORCHESTRATION.md`.

---

## D10: MTTR bottleneck (diagnosis vs remediation) must be measured before committing to Loop A vs auto-repair

**Status:** Accepted-conditional

**Context.** The reframe (D5) asserts the RCA copilot is ~80% of the value — true only if diagnosis is a real slice of MTTR. STRESS-TEST.md's devil's-advocate: this is asserted, not measured. If most MTTR is remediation (write/review/deploy), a diagnosis copilot polishes a step that was never the bottleneck. STRESS-TEST.md §9 also warns dirty data (rollbacks, entangled commits, lossy incident→commit linkage, fingerprint drift, no harm metric) makes a naive measurement lie.

**Options considered.**
1. Commit to Loop A now on the asserted 80% value.
2. Build a self-serve instrument that measures the diagnosis-vs-remediation split from the operator's own history first, and gate the Loop A-now / Loop C-earn-later decision on it.

**Decision.** Option 2. Ship a read-only, offline, Tier-0 instrument (`mttr-bottleneck`) that computes the `diagnosis_share = S2/(S2+S3)` distribution (plus a linkage-independent remediation-friction proxy from CI/deploy logs) and applies a two-gate decision rule (data-quality firewall, then split). Verdict space: **Loop A now** (diagnosis-heavy) / **Loop A deferred, fix remediation friction first** (remediation-heavy, corroborated by the friction proxy) / **instrument-and-reconsider** (thin/ambiguous data). Per-class overrides allowed with per-class data-quality floors. The instrument does **not** gate Loop B (verdict-independent).

**Why conditional.** The architecture must serve *both* branches until the number lands. Everything upstream of a write — signal layer, dedup, Incident Memory, verification gate, durable orchestration, HITL, audit — plus Loop B is verdict-independent and built now (D10-INSTRUMENT.md §6). The **only** capability that genuinely waits on the measurement is autonomous write access to production code (Loop C). So D5's center of gravity is accepted, but "commit hard to Loop A vs auto-repair" is held open until measured.

**Rationale.** Measuring first is cheaper than building the wrong loop. The instrument is deliberately cheaper than either loop and seeds the harm-metric baseline (D6) via its `audit.jsonl`.

**Consequences.**
- D10-INSTRUMENT.md owns the instrument, its config, `severity-map.yaml`, and the decision rule.
- **Seam (coherence critic D10 note):** D10-INSTRUMENT.md, LOOP-A-SPEC.md §8, and TRUST-CONTROLLER.md all reference `ARCHITECTURE-REFRAMED.md` as the doc that sequences build order and holds the D6 harm-window definitions the instrument seeds. That keystone must be written; it is where the D10 conditionality is operationalized against build order.
- Owner: `D10-INSTRUMENT.md`; build-order and harm-window definitions in `ARCHITECTURE-REFRAMED.md`.

---

## Cross-cutting: what the decisions jointly obligate

- **Every decision honors the three cross-cutting invariants** (ARCHITECTURE-ORIGINAL.md §12): a replayable why-trace, a kill switch (diagnosis-only freeze: evaluate + record, block all downstream actions), and an immutable audit log. The kill switch has three enforcement points (orchestrator tier-transition guard, TRUST-CONTROLLER.md effective-L0, VERIFICATION-GATE.md `frozen`); the authoritative kill bit and how all three derive from it is owned by `ORCHESTRATION.md` (coherence critic MAJOR #6).
- **Two keystones remain unwritten and hold most unresolved seams:** `ORCHESTRATION.md` (BLOCKER #4 `notify_state`; MAJOR #6 kill bit; MAJOR #7 router + L↔tier crosswalk) and `HITL-APPROVAL.md` (attack #6 — the still-open off-hours L2-runs-24/7-vs-gated-tiers-sleep inversion; the shared Telegram approval channel; kill-switch release auth). `ARCHITECTURE-REFRAMED.md` holds the `auto_action`/`assisted_action` write-path (D6 BLOCKER #3), the `W_confirm→W_mature` fix (D6 BLOCKER #2), the `OutcomeEvent` field-name pin `actionId` (BLOCKER #1), the D9 single-source (#9), and the build-order that D10 gates.
- **One attack remains OPEN and unowned:** STRESS-TEST.md #6 (perverse async-HITL schedule — the ungated L2 quarantine runs 24/7 while human-gated tiers go dark off-hours). No current spec owns the off-hours autonomy-vs-trust inversion for L2. `HITL-APPROVAL.md` must own it. All other attacks #1–#9 are closed by the owners named above.
- **Numbering hygiene:** "attack #11 (diff-stacking)" cited in VERIFICATION-GATE.md is **not** a stress-test finding (STRESS-TEST.md has only #1–#9). The diff-stacking guard is real and correctly owned by TRUST-CONTROLLER.md §4.1 as a **net-new** area-keyed churn escalator; the label must be stripped or formally registered, and the churn input source (`auto_action` table vs gate-result stream — coherence critic MAJOR #11) pinned to the apply-time writer.
