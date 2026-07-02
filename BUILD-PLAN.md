# Build Plan (reframed §14)

Replaces ARCHITECTURE-ORIGINAL.md §14. The original §14 sequenced autonomy tiers on
the *assumption* that reactive production auto-repair is the product. The reframe
(STRESS-TEST.md "What survives", decisions D5/D10) moved the center of gravity to
**diagnosis + test-suite healing**, and made production-code autonomy (Loop C)
**deferred and outcome-earned, per-incident-class**. This plan sequences the reframed
system accordingly: it builds the honest MVP first, gates each phase on a falsifiable
acceptance check, makes the *first* phase the D10 measurement the whole reframe is
conditional on, and ties every autonomy expansion to the Trust Controller's outcome
data (D6) — never to calendar time.

Terse register. Every phase has a **GATE** (a hard precondition on entering the next
phase) and a **verify:** (a falsifiable acceptance check for the phase itself). If a
verify fails, you do not advance — you fix or you stop. Nothing here is aspirational;
each milestone is a shippable, testable artifact.

Cross-refs by filename: `ARCHITECTURE-ORIGINAL.md`, `STRESS-TEST.md`, `LOOP-A-SPEC.md`,
`LOOP-B-SPEC.md`, `VERIFICATION-GATE.md`, `INCIDENT-MEMORY.md`, `TRUST-CONTROLLER.md`,
`SECURITY-THREATMODEL.md`, `D10-INSTRUMENT.md`, and the two keystones the coherence
review flagged as load-bearing-but-unwritten: `ORCHESTRATION.md` and `HITL-APPROVAL.md`
(plus `ARCHITECTURE-REFRAMED.md` for the crosswalk/window definitions). This plan
**depends on those three keystones existing** and names exactly where (Phase 1 §GATE).

---

## 0. The honest MVP — what we build, and what we explicitly do NOT

**Build, in this order, to reach v1:**

1. **D10 instrument** (`D10-INSTRUMENT.md`) — the offline, read-only, zero-write MTTR
   bottleneck measurement. Tier 0 by construction. **First**, because the reframe's
   center of gravity (Loop A) is *conditional* on it (D5 is conditional on D10).
2. **Loop A — RCA copilot** (`LOOP-A-SPEC.md`) — signal → dedup → grounded RCA why-trace
   handed to the on-call human. **Tier 1 forever, ZERO write access to app code.** This
   is the v1 product (assuming D10 says diagnosis-heavy; see §Phase 0 branch).
3. **Loop B — flaky quarantine (autonomous) + heal-assist (human-gated, PR-time
   author-assist)** (`LOOP-B-SPEC.md`). Verdict-independent of D10 — ships regardless.
   Coverage-gap generation is **deferred** (LOOP-B-SPEC.md v1 scope).

**Explicitly NOT built in v1 (stated so no reader assumes it is coming by default):**

- **Loop C — autonomous production-code repair.** Deferred. No repair worker writes to
  app code in v1. Loop C is *earned later, per-incident-class, on measured outcome data*
  (D5, D6, D10), mutation-gated, business-hours, proven-reversible. It is never
  architected first, and no phase below turns it on by default — a phase can only make it
  *reachable* for a single class the Trust Controller has independently earned.
- **Coverage-gap generation** (Loop B's third job). Lowest-ROI, matters only on thin
  suites where the premise is shakiest (LOOP-B-SPEC.md). Deferred behind Loop B v1.
- **Predictive / cross-service detection** (original §14 Phase 4). Not in scope; the
  reactive signal layer must earn its keep first.
- **The judge-agent as a gate.** It exists (`VERIFICATION-GATE.md` S9) but is advisory
  only, never load-bearing (D8). Not a v1 gating mechanism.
- **Any second-LLM "independent verification."** Independence comes from signals (D8).

The whole point of the MVP: ~80% of the value at ~10% of the risk (STRESS-TEST.md
"What survives" #1) with a blast radius a human can actually reason about — Loop A never
writes, Loop B's autonomous job (quarantine) *asserts no behavior* and its behavior-
changing job (heal) is human-gated at PR time by the one true intent oracle, the author.

---

## 1. Build-order dependencies (what blocks what)

The reframe has one hard structural fact: **the shared substrate serves both D10
branches, so most of it is built regardless of the verdict** (`D10-INSTRUMENT.md` §6).
Only *autonomous write to production code* (Loop C) is truly contingent.

```
                    ┌─────────────────────────────────────────────┐
                    │  D10 instrument (Phase 0)                     │
                    │  offline, read-only, seeds the corpus         │
                    └───────────────┬───────────────────────────────┘
                                    │ verdict gates Loop A now vs deferred
                                    │ (NOT Loop B — verdict-independent)
   ┌────────────────────────────────┼────────────────────────────────────┐
   │  SHARED SUBSTRATE (build regardless of verdict — D10-INSTRUMENT §6)    │
   │                                                                        │
   │  Signal layer + auth ingestion (ARCH §2, SECURITY §2, D7)              │
   │  Aggregation & dedup + fingerprint (ARCH §3)                           │
   │  Incident Memory (Postgres+pgvector, D1)  ── INCIDENT-MEMORY.md        │
   │  Durable orchestration (AgenticOps PG state machine, D1) ─ ORCHESTRATION│
   │  HITL Telegram bot + kill switch + immutable audit ─ HITL-APPROVAL.md   │
   │  Verification Gate (mutation/must-fail/signals) ── VERIFICATION-GATE.md │
   └───────┬───────────────────────────────────────────────┬───────────────┘
           │                                                │
           ▼                                                ▼
   ┌───────────────────────┐                    ┌───────────────────────────┐
   │ Loop A (RCA copilot)   │                    │ Loop B (test self-healing) │
   │ Tier 1, ZERO write     │                    │ quarantine (auto) +        │
   │ LOOP-A-SPEC.md         │                    │ heal-assist (human-gated)  │
   │ NEEDS: signal, dedup,  │                    │ LOOP-B-SPEC.md             │
   │ Incident Memory,       │                    │ NEEDS: Verification Gate,  │
   │ orchestration, HITL,   │                    │ per-test-per-commit CI,    │
   │ + Incident-Memory      │                    │ single-test-@-commit       │
   │   outcome watcher (#8) │                    │ sandbox, HITL PR channel   │
   └───────────────────────┘                    └───────────────────────────┘
           │                                                │
           │  outcome data (D6) accrues in Incident Memory  │
           ▼                                                ▼
   ┌────────────────────────────────────────────────────────────────────────┐
   │  Trust Controller (TRUST-CONTROLLER.md) — consumes outcome events,        │
   │  owns autonomy level per class. Loop C is UNREACHABLE until it earns a    │
   │  class into an auto level on OUTCOME data (D6), never on calendar time.   │
   └────────────────────────────────────────────────────────────────────────┘
```

**Prerequisite chains (must be true before the dependent thing runs):**

- **Incident Memory + signal layer + Verification Gate are prerequisites for *either*
  D10 branch** (Loop A copilot *or* the deferred Loop C). None of Loop A / Loop B / Loop C
  can be trusted without them: Loop A needs Incident Memory for outcome-weighted retrieval
  and its outcome watcher (LOOP-A-SPEC.md §1/§6/§8, coherence #8); Loop B needs the
  Verification Gate's must-fail/no-weakening signals (LOOP-B-SPEC.md guards; D4);
  Loop C — if ever earned — needs the grounded-repro + mutation gate (D2/D3/D4).
- **The two write-path keystones gate everything downstream of a write.**
  `ORCHESTRATION.md` owns `notify_state` (coherence #4), the kill bit's single source
  (#6), and the `AutonomyLevel → (loop, tier, requiredMutationScore, accountabilityOwner)`
  router + L↔tier crosswalk (#7). `HITL-APPROVAL.md` owns the async approval ladder, the
  Telegram channel, and kill-switch release auth, and **owns the still-open attack #6**
  (off-hours autonomy-vs-trust inversion). Neither Loop can ship past diagnosis without
  them.
- **The `auto_action` / `assisted_action` write path must be owned before the Trust
  Controller can leave L1 for any class** (coherence #3, "the single most load-bearing
  gap"). `ARCHITECTURE-REFRAMED.md` must assign the producer of `auto_action` rows (both
  `machine` and `human_approved` variants), reconcile Incident Memory's "NULL for
  human-merged" rule against TC's need for `assisted_action`, pin the `OutcomeEvent`
  field name (`actionId`, coherence #1), delete `W_confirm` in favor of `W_mature`
  (coherence #2), and reconcile the label vocabulary (coherence #5). **This is a Phase 3
  entry gate**, not a v1 requirement — Loop A/B v1 do not need TC to leave L1.

---

## Phase 0 — Measure the bottleneck (D10). The reframe is conditional on this.

**Goal.** Answer, from the operator's *own* history: is MTTR dominated by **diagnosis**
(figuring out what's wrong) or **remediation** (shipping the fix)? Everything downstream
of Loop A is conditional on this number (D5 conditional on D10). Build the cheapest thing
first: a read-only, offline, idempotent analytics job (`D10-INSTRUMENT.md`), Tier 0 by
construction — no agent, no write path, no prod access.

**Milestones (concrete, buildable):**

- `mttr-bottleneck` script (`D10-INSTRUMENT.md` §4) over the five existing data sources
  (incident tracker, git, deploy log, CI log, chat). No new infra to *collect* data —
  it reads exports.
- The A6 firewall: mitigation quarantine, `forward-fix-irreversible` tagging, entangled-
  commit exclusion, `pr_opened_proxy` sensitivity band, three-tier linkage confidence,
  `remediation_floor_min` linkage-independent proxy (§3.6).
- Outputs: `split-histogram`, `by-class.json`, `remediation-friction.json`,
  `data-quality.json`, `recommendation.md`, replayable `audit.jsonl`.
- **This run seeds the Incident Memory corpus** — `audit.jsonl` is the baseline the harm
  metric later diffs against (`D10-INSTRUMENT.md` §6).

**Parallel track (start now, do not wait on the verdict):** begin the shared substrate
(§1) — signal layer, dedup, Incident Memory, orchestration, HITL, Verification Gate — all
verdict-independent per `D10-INSTRUMENT.md` §6, and **Loop B**, which is D10-independent.
Idleness while measuring is a planning error.

**The branch (this is the whole point of Phase 0):**

| D10 verdict (`D10-INSTRUMENT.md` §5, Loop A / Loop C only) | What Phase 1 does |
|---|---|
| **Diagnosis-heavy** (`median diagnosisShare ≥ 0.60` ∧ `median S2 ≥ 15min`) | **Loop A rides now.** Its grounded why-trace attacks the dominant slice. Proceed to Phase 1 building Loop A as the v1 product. |
| **Remediation-heavy** (`median ≤ 0.40` ∧ `remediation_floor_min ≥ median S2`) | **Loop A deferred.** Diagnosis is not the bottleneck; the data-pointed lever is remediation friction (CI/review/deploy latency), fixed with *conventional tooling first*, then re-measure. Loop C is the eventual — but still deferred, per-class, outcome-earned (D6) — target. Phase 1 ships Loop B only + shared substrate; **no agent loop is turned on for Loop A**. |
| **Neither dominates / thin data / Gate 0 fail** | **Instrument-and-reconsider.** Ship the measurement infra + shared substrate + Loop B, run a rolling window (raise `high_link_share` by enforcing incident-id in PR titles), decide on real per-class data. **Do not build Loop A or earn Loop C on a coin-flip.** Per-class override still applies: a single `IncidentClass` that independently clears the diagnosis-heavy bar + its own data-quality floors earns **Loop A scoped to that class**. |

**Note on Loop B:** it ships in *every* branch. The D10 verdict does **not** gate Loop B
(`D10-INSTRUMENT.md` §1 "What it does not gate"). Do not read a Loop-B recommendation out
of this instrument — that would be circular.

**GATE → Phase 1:** `recommendation.md` emits a verdict that passes Gate 0 (data quality),
**or** an explicit "instrument-and-reconsider" with a named rolling-window plan. Either is
a pass — the failure state is *proceeding to build Loop A with no measured basis at all*.

**verify:** run `mttr-bottleneck` on ≥ `min_eligible_incidents` (default 30) incidents
within the rolling window; `recommendation.md` names one of the three verdicts with its
supporting evidence legs (split distribution **and** friction proxy), and the run is
byte-reproducible from the same exports + cached labels (`D10-INSTRUMENT.md` §3
replayability). Falsifiable: a second run on identical inputs producing a different
verdict = fail.

---

## Phase 1 — Shared substrate: signal → dedup → memory → gate, orchestrated, with HITL + kill switch.

**Goal.** Stand up everything upstream of a write, plus the safety spine, so that *either*
D10 branch has its foundation. This is the largest phase and the one the coherence review
warns hardest about: it is where the two unwritten keystones must land.

**Milestones:**

- **Signal layer with authenticated ingestion** (`ARCHITECTURE-ORIGINAL.md` §2,
  `SECURITY-THREATMODEL.md` §2, D7): HMAC/mTLS verify-before-normalize, source allow-list,
  per-`(source,fingerprint)` rate limit, business-metric & browser-RUM signals can open
  **only** Loop A (read-only) — the spoof→repair sever (SECURITY §2.1). Normalize into the
  `Incident Candidate` contract (ARCH §2).
- **Aggregation & dedup** with fingerprinting + noise suppression (`ARCHITECTURE-ORIGINAL.md`
  §3). Fixes D10's fingerprint-drift here (dedup by `(service, path-overlap, adjacency)`).
- **Incident Memory** (`INCIDENT-MEMORY.md`): Postgres+pgvector (D1), split immutable-trace
  / mutable-label design, four-rung fingerprint hierarchy, drift-resistant recurrence
  (fingerprint OR `symptom_signature + module_area` OR vector), confirmed-good-only
  positive-exemplar write gate (D6, closes attack #8), WORM audit mirror, read-time
  untrusted-text wrapping (D7).
- **Durable orchestration** = `ORCHESTRATION.md` (D1, AgenticOps Postgres state machine, no
  new runtime). Must define: `notify_state` column + CAS semantics vs `incidents.status`
  (coherence #4 — Loop A's anti-double-notify guarantee has no backing store without it);
  the kill bit single source + how TC's `effectiveLevel`, the gate's `frozen`, and the
  transition guard all derive from it (coherence #6); the `AutonomyLevel → (loop, tier,
  requiredMutationScore, accountabilityOwner)` router + the **one crosswalk** for
  Tier 1–4 / L0–L3 / loop-A/B/C (coherence #7). Also: who invokes Loop A and the gate.
- **HITL layer** = `HITL-APPROVAL.md` (`ARCHITECTURE-ORIGINAL.md` §8): Telegram bot with
  inline approve/reject/edit + deep-link to the full why-trace, async-by-default approval
  ladder with timeout + escalation, kill-switch release auth (MFA, few-writer, off-band —
  SECURITY §7.1). **Owns the still-open attack #6** (off-hours autonomy-vs-trust inversion:
  state explicitly whether autonomous jobs pause to PR outside staffed hours or are gated
  on business-hours + fast-rollback + traffic-%).
- **Verification Gate** (`VERIFICATION-GATE.md`): the full non-LLM signal battery
  (S1 build, S3 full suite, S4 must-fail-on-parent, S5 mutation-on-touched-module,
  S6 no-weakening, S7 static/security, S8 reversibility, S9 judge advisory-only). Stateless,
  per-`(parentSHA,fixSHA)`, takes a resolved `(loop, tier)` — does **not** own tiers.
- **Cross-cutting spine**: replayable why-trace, kill switch (freeze = diagnosis-only for
  the whole network — ARCH §12 principle 5), immutable hash-chained externally-anchored
  audit log (SECURITY §7.2).

**Kill switch is functional in this phase** — it must exist before any loop runs, even a
read-only one, so the whole network can be frozen to diagnosis-only on command.

**GATE → Phase 2:** `ORCHESTRATION.md` and `HITL-APPROVAL.md` **exist and are implemented**,
with `notify_state`, the kill bit single-source, and the L↔tier crosswalk defined (coherence
#4/#6/#7 closed). Verification Gate returns a `GateResult` for a known `(parentSHA,fixSHA)`
pair. Authenticated ingestion rejects an unsigned/forged signal at the edge. Incident Memory
stores and retrieves a why-trace.

**verify (all falsifiable):**
- Post a forged Sentry payload with no valid HMAC → **rejected before normalization**, audit
  event written (SECURITY §2.1). A signed one is accepted.
- Engage the kill switch → every downstream *action* (auto-apply, PR-open, HITL ping) is
  blocked while evaluation + audit still run; `GateResult.frozen = true` (VERIFICATION-GATE
  §7). Heartbeat-absence also freezes (SECURITY §7.1).
- Feed the gate a **vacuous** regression test (passes on parent) → S4 FAIL, gate FAIL
  (VERIFICATION-GATE S4). Feed a genuine one → S4 pass.
- Kill the orchestrator mid-incident, restart → incident state survives, `notify_state` is
  consistent, no double-notify (D1, coherence #4).
- Audit chain re-walk under an independent identity verifies clean; a tampered past row
  breaks the chain and pages P1 (SECURITY §7.2).

---

## Phase 2 — Ship the MVP: Loop A (if diagnosis-heavy) + Loop B (always).

**Goal.** Turn on the two v1 loops on top of the Phase 1 substrate. This is the product
release. **Still zero autonomous writes to production code.**

**Milestones:**

- **Loop A — RCA copilot** (`LOOP-A-SPEC.md`), *if* Phase 0 said diagnosis-heavy (or a
  per-class override earned it). Signal → dedup → RCA agent → grounded why-trace handed to
  on-call. **Tier 1 forever, zero write access to app code.** Grounded booleans only
  (G1–G7), never self-reported LLM confidence (D3). Delivery is a CAS on `notify_state`
  (owned by `ORCHESTRATION.md`, Phase 1). Buttons write `provisional_human_confirmed`
  feeding RCA-accuracy metrics; promotion to `confirmed_good` requires the Incident Memory
  outcome watcher's window (LOOP-A-SPEC.md §7/§9, coherence #5/#8). **Hard prerequisite:
  the Incident Memory outcome watcher** (LOOP-A-SPEC.md §1/§8, coherence #8).
- **Loop B — flaky quarantine (autonomous)** (`LOOP-B-SPEC.md`): detect non-determinism
  (re-run ×N + order-shuffle), tag `@flaky`, open low-pri evidence PR, never silently
  delete. The one autonomous merge, fenced server-side (SECURITY §5.1): changed-paths diff
  touches **only** the quarantine tag / skip-list, required status check for the machine-
  applied `quarantine` label, `quarantines/week` cap + rising-flaky-rate alert. Gate runs
  S1/S3 + degrades S7 to a scope check (VERIFICATION-GATE §5 col 1).
- **Loop B — test heal (human-gated, PR-time author-assist)** (`LOOP-B-SPEC.md`): the A-vs-B
  discriminator, PR-time prompt to C's author (the intent oracle), heal applied in the same
  PR *only on author confirm*, then the non-LLM guards — S4 must-fail-on-parent, S6
  no-weakening (VERIFICATION-GATE §3/§5 col 2). **Author approval is required** (never
  autonomous).

**What is still NOT on:** Loop C (no repair worker writes app code); coverage-gen; any
auto-apply of a production-code fix. The Trust Controller is either not yet built or built
but pinned at L1 for all classes (it cannot leave L1 until the Phase 3 gate).

**GATE → Phase 3:** Loop A why-traces are accruing `provisional_human_confirmed` → watcher-
matured `confirmed_good`/`wrong_rca` outcomes in Incident Memory, i.e. **there is outcome
data for the Trust Controller to consume** (D6). Loop B heals are landing in author PRs with
S4/S6 green. This is the point where enough *outcome* signal exists to even discuss autonomy
expansion — and note it is a **data** condition, not a calendar condition.

**verify (falsifiable):**
- Loop A produces a grounded why-trace whose `correlationState`/gate booleans (G1–G7) are
  reproducible on replay from the same signal (LOOP-A-SPEC.md; replayability). A forged
  signal that does not localize/reproduce dead-ends at ESCALATE, does not fabricate a
  confident RCA (SECURITY §2.4).
- A flaky test is quarantined autonomously; the merge is **refused** if the diff touches any
  non-quarantine path (SECURITY §5.1 condition 1).
- A legitimate regression (class A: crash, or break in code C didn't touch) is **never**
  offered as a heal (LOOP-B-SPEC.md steps 3/4). A stale-test (class B) heal is offered only
  to the author, applied only on confirm, and fails the gate if it weakens an assertion
  (S6).
- No production app-code file is written by any agent in this phase (grep the audit log:
  zero `auto_action` rows with `applied_by='machine'` on app paths).

---

## Phase 3 — Trust Controller online; autonomy expansion tied to OUTCOME data (D6), never calendar.

**Goal.** Stand up the Trust Controller (`TRUST-CONTROLLER.md`) as the *sole* owner of
autonomy level per incident class, driven by the outcome data accrued in Phases 0–2. This
phase does **not** turn on Loop C — it makes autonomy *expansion possible and governed*, and
wires the write-path bookkeeping that expansion depends on.

**Entry gate (coherence blockers — must be closed before TC can leave L1 for anything):**

- `ARCHITECTURE-REFRAMED.md` assigns the **producer of `auto_action` rows** — both
  `machine` (auto-apply commit) and `human_approved` (`assisted_action`, i.e. L1 human-
  merged PR) variants (coherence #3, "the single most load-bearing gap"; without it the
  promotion ladder is dead on arrival — TC can never leave L1).
- `OutcomeEvent` field name pinned to `actionId` and propagated to both Incident Memory and
  TC (coherence #1).
- Incident Memory's maturation rebound from `W_confirm` to `W_mature = max(W_recur, W_spawn,
  W_revert)` (coherence #2 — closes the attack-#8 boundary race).
- Incident Memory's spawn/recurrence/revert attribution + harm query extended to cover
  **both** `applied_by` variants, so TC's `l1_merged_harm_rate` (the rubber-stamp-band
  defense of attack #3) is computable (coherence #8).
- D9 accountability owner single-sourced (`trust_class.owner` authoritative) and its
  propagation path into the gate input + `resolutions.merged_by` defined (coherence #9).

**Milestones:**

- **Trust Controller** (`TRUST-CONTROLLER.md`): append-only `trust_transition`, `level` /
  `earned_level` split, `effectiveLevel` = min level across touched areas + churn-hold cap,
  asymmetric fast-demote/slow-promote, the area-keyed windowed churn escalator (§4.1,
  consuming the gate's `moduleArea`/`diffLines`), circuit breaker (§4.2), D9 owner CHECK at
  L2+ (§3.6).
- **Outcome-based expansion wiring (D6):** promotion is gated on independent OUTCOME signals
  — incident recurrence, new-incident-spawn in the touched module_area, later human revert —
  **not** human-override-rate alone (which is ambiguous: "good" vs "nobody checked",
  STRESS-TEST #3). Demotion is fast; promotion is slow and requires the full harm window to
  close.
- **`accountability.yaml` / per-class owner** populated; every auto-eligible class has a
  named accountable engineer *before* the capability exists (D9, SECURITY §6).

**Explicitly still NOT on:** Loop C auto-apply. TC may now *hold* a class at L1 and *observe*
whether its outcome data would ever justify L2+, but the Verification Gate hard-refuses the
auto column for Loop C until TC returns an auto level for that class (VERIFICATION-GATE §5
footnote 2), and even then only per the Phase 4 gate.

**GATE → Phase 4:** For **at least one** narrow incident class, the outcome data shows the
D6 promotion criteria *would* be met (measured recurrence ≈ 0 over the harm window, no
spawn, no revert, on a statistically meaningful count), AND that class is mutation-strong
(S5 floor cleared on its module_area), reproducible without prod data (SECURITY §4.2),
side-effect-free-attested (S8 clause 0), and has a named owner (D9). This gate is
**per-class and outcome-conditioned** — passing it for one class says nothing about any
other.

**verify (falsifiable):**
- Inject a synthetic "subtly-wrong fix that goes green but recurs in 10 days" into the
  outcome pipeline → TC reads the **recurrence outcome**, does NOT promote (does the opposite
  of the STRESS-TEST #3 runaway), regardless of a low override rate (D6).
- A class with zero `assisted_action`/`auto_action` rows **cannot** be promoted (there is no
  outcome data) — TC pins it at L1 (coherence #3 closed → the ladder has a data source).
- Attempt to configure an L2+ class with `owner = null` → startup validation / CHECK
  constraint hard-fails (TC §3.6, coherence #9).
- Advance the clock by calendar time alone with no outcome data → **no promotion** (proves
  expansion is data-tied, not calendar-tied, D6).

---

## Phase 4 — Earn Loop C for a single proven class (deferred capability, unlocked per-class).

**Goal.** *Only if* Phase 3's per-class gate passed for a class: unlock autonomous
production-code repair for **that one class**, under the strictest possible envelope. This is
the deferred Loop C, and it is unlocked one incident-class at a time, never wholesale.

**Preconditions (all required, per `TRUST-CONTROLLER.md` / D5 / STRESS-TEST "What survives"
#3):** the class is mutation-gated (S5), must-fail-on-parent-enforced (S4), proven
side-effect-free (S8 positive attestation, clause 0), reproducible without prod data
(SECURITY §4.2 — data-dependent classes are structurally ineligible, stay Loop A forever),
business-hours-only, with a prepared+clean-applying revert, a named accountable owner (D9,
gate hard-FAILs the auto column if `accountabilityOwner` is null — VERIFICATION-GATE §5),
and it uses a **separate per-class identity**, never the general repair account (SECURITY
§5.1).

**Milestones:**

- Repair worker (`ARCHITECTURE-ORIGINAL.md` §6) in the ephemeral, egress-denied, secret-less
  sandbox (SECURITY §4), scoped to the one earned class's non-protected paths.
- The grounded-repro → must-fail regression → mutation-on-touched-module chain as the
  *sole* confidence source (D2/D3/D4). No self-reported LLM confidence anywhere in the
  decision.
- Auto-apply confined to the S8 `side_effect_free_modules` allowlist, business-hours window
  enforced (attack #6 answer from `HITL-APPROVAL.md`), fast-rollback wired.

**GATE → (expand to next class):** the earned class runs auto-apply with **measured zero
net-harm** over a full harm window — no auto-caused/worsened incidents, no recurrence-in-
touched-area, no human revert (the safety number STRESS-TEST #9 says is missing from the
original §13). Only then is the *next* candidate class considered, and only through the same
Phase 3 → Phase 4 outcome gate. There is no "expand everything" step — ever.

**verify (falsifiable):**
- An auto-apply attempt on a fix whose regression test cannot be made to execute against
  parent-behavior (S4 inconclusive) is **routed to a human, never auto-applied**
  (VERIFICATION-GATE S4 residual-limitation clause).
- An auto-apply attempt touching a non-attested module (not on `side_effect_free_modules`) is
  **refused** (S8 clause 0), routed to human-gated PR.
- An auto-apply attempt outside the business-hours window is refused (attack #6 answer).
- The circuit breaker demotes the class on the first auto-caused incident (TC §4.2), fast
  (asymmetric demote), and the kill switch still freezes the whole network to diagnosis-only
  in one command (ARCH §12).

---

## Phase sequencing summary

| Phase | Ships | Autonomy | GATE to advance (falsifiable) |
|---|---|---|---|
| **0** | D10 instrument (offline, read-only) | Tier 0 (no agent) | Verdict passes Gate 0 *or* explicit instrument-and-reconsider plan |
| **1** | Signal+auth, dedup, Incident Memory, orchestration, HITL, Verification Gate, kill switch | none (substrate) | `ORCHESTRATION.md` + `HITL-APPROVAL.md` implemented; forged signal rejected; kill switch freezes; vacuous test FAILs S4 |
| **2** | Loop A (if diagnosis-heavy) + Loop B quarantine (auto) + heal-assist (human-gated) | Tier 1 read-only + one bounded autonomous merge (quarantine) | Outcome data accruing in Incident Memory; zero machine writes to app code |
| **3** | Trust Controller online; outcome-based expansion wiring | still L1 for all classes | ≥1 class *would* meet D6 criteria on measured outcome data; write-path blockers (#1/#2/#3/#8/#9) closed |
| **4** | Loop C for ONE earned class only | per-class auto-apply, business-hours, mutation+reversibility-gated | measured zero net-harm over a full window → consider next class via same gate |

**The invariant across all phases:** autonomy expansion is a function of **measured
outcome data** (D6), scoped **per incident-class**, gated on **grounded booleans** (D3) and
**mutation score + must-fail-on-parent** (D4), with **independence from signals not a second
LLM** (D8), a **named owner** (D9), and a **kill switch** that returns the whole network to
diagnosis-only. No phase advances on calendar time. Loop C is never architected first; it is
earned last, one class at a time, or never.
