# Self-Healing Ops — Reframed Architecture

> **Supersedes `ARCHITECTURE-ORIGINAL.md`.** That document is retained as the original target-state and the input to the adversarial review. This is the new source of truth. Where the two disagree, this wins. The adversarial review is `STRESS-TEST.md`; the decisions it forced (D1–D10) are honored here and never relitigated.
>
> This document is the **keystone**: it states the reframe, gives the topology, fixes the tier/risk model, folds in metrics (including the harm metric the original omitted), restates guardrails, and — critically — resolves the cross-component seams the coherence review flagged (the `auto_action` write-path, the maturation-window contradiction, the `OutcomeEvent` field name, the label vocabulary, and the single source of the D9 owner). It integrates the component specs by reference; it does not duplicate their internals.

---

## 0. The reframe (why the center of gravity moved)

The original architecture (`ARCHITECTURE-ORIGINAL.md` §1–§8) put autonomous production-code repair at the center: Signal → RCA → Risk Classifier → Repair Worker → Verification Gate → auto-apply. The stress test showed that center is aimed at the wrong target. Two of its own sections quietly said so (§9.2 "self-healing of the existing suite is where the value is"; §6 "garbage in, garbage out"). The decisive arguments:

1. **The safe zone and the bug zone are nearly disjoint (STRESS-TEST §1).** To be auto-fixable, a production bug must be *simultaneously* reproducible-from-telemetry, small-diff, in strongly-covered code, outside protected paths, and confidently root-caused. But strong coverage is *anti-correlated* with the bug reaching production in the first place. Stack the original §15's own admission (most incidents are config/data/capacity/upstream — untouchable by code-only repair workers) and reactive production auto-repair is a **minority of a minority**.

2. **Confidence is load-bearing and was undefined (STRESS-TEST §2, D3).** `0.9³ ≈ 0.42`: a three-step RCA→fix→verify chain is below coin-flip unless every factor is *grounded* — an observed boolean, not a self-reported LLM number, which is ~uncorrelated with correctness.

3. **The trust-expansion loop was a positive-feedback runaway (STRESS-TEST §3, D6).** Expanding autonomy on low human-override-rate rewards the ambiguous "nobody checked" case identically to the "good fix" case — precisely as the weak suite lets subtly-wrong fixes through green.

**Therefore the reframed center of gravity is diagnosis + test-suite healing, not autonomous production repair.** The system is **two loops plus a deferred third**:

| Loop | What it is | Autonomy | Write access to app code | Status |
|---|---|---|---|---|
| **A — RCA copilot** | Signal → dedup → RCA agent → **grounded why-trace handed to the on-call human**. | Tier 1 forever. | **Zero.** | v1 product. See `LOOP-A-SPEC.md`. |
| **B — test-suite self-healing** | Flaky quarantine (autonomous), test healing (human-gated, PR-time author-assist), coverage gaps (later). | Split by blast radius. | Test files only, path-scoped, mostly human-gated. | v1. See `LOOP-B-SPEC.md`. |
| **C — autonomous production-code repair** | The original centerpiece, demoted to a deferred tail. | Earned **later, per-incident-class**, on measured **outcome** data, mutation-gated, business-hours, proven-reversible. | Non-protected source paths only, when/if earned. | **Deferred. Never architected first.** See `LOOP-C-DEFERRED.md`. |

Loop A is "~80% of the value, ~10% of the risk" (STRESS-TEST §"What survives"). That claim is not asserted — it is **conditional on D10**: whether diagnosis is actually the MTTR bottleneck is *measured first* by the self-serve instrument in `D10-INSTRUMENT.md` before Loop A is committed to over Loop C. The architecture below serves both branches of that measurement (§8).

**What survives unchanged** (STRESS-TEST §"What survives"): the tier model, async HITL, replayable why-traces, the kill switch, the §6 bootstrapping honesty, and the §9.2 insight. This document keeps all of them; it only moves the center of gravity and corrects the tier/risk model.

---

## 1. Reframed pipeline topology

Everything upstream of a *write* serves both the diagnosis branch (Loop A) and the deferred repair branch (Loop C), and serves Loop B — so it is built once, now (§8). The only capability that genuinely waits on the D10 verdict is autonomous write access to production code (Loop C).

```
                          UNTRUSTED ZONE (attacker-reachable inputs — SECURITY-THREATMODEL.md §1)
                          internet · product users · any telemetry-emitting workload
                                              │
              ┌───────────────────────────────┴─── B1: authenticated ingestion ───────────────┐
              │  HMAC / mTLS + source allow-list, verify-BEFORE-normalize (SECURITY §2, D7)     │
              ▼                                                                                  │
   ┌─────────────────────── SIGNAL LAYER (reuse existing; ARCH-ORIG §2) ──────────────────────┐ │
   │  backend logs/OTel/metrics · deploy & flag events · frontend RUM · business signals       │ │
   │  → normalized Incident Candidate                                                          │ │
   └───────────────┬───────────────────────────────────────────────────────────────────────────┘ │
                   ▼                                                                                │
   ┌─── AGGREGATION & DEDUP (ARCH-ORIG §3; fingerprint + drift-resistant keys) ───┐                 │
   │  N-events/window noise suppression · blast_radius×freq×criticality priority   │                 │
   └───────────────┬───────────────────────────────────────────────────────────────┘                 │
                   │        ┌──────────────────────────────────────────────┐                       │
                   ▼        ▼                                              │ retrieval (read)      │
        ╔══════════════════════════════════╗          ┌─────────────────────────────────────────┐  │
        ║ LOOP A — RCA COPILOT             ║◄────────►│  INCIDENT MEMORY  (Postgres + pgvector,   │  │
        ║ (LOOP-A-SPEC.md · Tier 1 · NO    ║  grounded │  reused AgenticMind infra — D1)           │  │
        ║  write/exec tool — SECURITY §3.3)║  booleans │  INCIDENT-MEMORY.md                       │  │
        ║ signal→dedup→RCA→grounded        ║          │  · immutable why-trace (write-once)       │  │
        ║  why-trace                       ║──────────►│  · outcome-weighted exemplars (D6, §8-poison)│
        ╚═══════════════╦══════════════════╝  emit     │  · projects OutcomeEvent → TRUST-CTRL (§4) │  │
                        │ hand to human               └───────────────────────────────────────────┘  │
                        ▼                                              ▲                              │
        ┌───────────────────────────────────────────┐                 │ OutcomeEvent{actionId,…}     │
        │ HITL / ON-CALL  (HITL-APPROVAL.md)          │                 │ (§3.2 write-path)            │
        │ Telegram bot: why-trace, buttons,           │                 │                              │
        │ async approval ladder, kill-switch release  │                 │                              │
        └───────────────┬─────────────────────────────┘                 │                              │
                        │ human acts (Loop A) │ approves heal (Loop B) │ approves fix (Loop C)         │
                        ▼                                                │                              │
        ╔════════════════════════════════════════════╗                 │                              │
        ║ LOOP B — TEST-SUITE SELF-HEALING            ║                 │                              │
        ║ (LOOP-B-SPEC.md)                            ║                 │                              │
        ║  flaky quarantine [AUTONOMOUS merge, §5.1]  ║                 │                              │
        ║  test heal [HUMAN-GATED PR, author-assist]  ║                 │                              │
        ║  coverage gaps [later, low-pri PR]          ║                 │                              │
        ╚═══════════════╦═════════════════════════════╝                 │                              │
                        │                                               │                              │
        ╔═══════════════▼═════════════════════════════╗                 │                              │
        ║ LOOP C — PROD-CODE REPAIR  [DEFERRED]        ║                 │                              │
        ║ (LOOP-C-DEFERRED.md · earned per-class, D5) ║                 │                              │
        ║  repair worker → sandbox repro (D2)         ║                 │                              │
        ╚═══════════════╦═════════════════════════════╝                 │                              │
                        │ every machine-authored change                 │                              │
                        ▼                                               │                              │
   ┌───────────────── VERIFICATION GATE (VERIFICATION-GATE.md) ──────────────────┐                    │
   │  per-change, stateless, in ephemeral sandbox (least-priv SA, egress deny)    │                    │
   │  SIGNAL BATTERY (non-LLM, D8): build · suite · MUST-FAIL-ON-PARENT (D4) ·     │                    │
   │  MUTATION SCORE on touched module (D4) · no-weakening · static/sec ·          │                    │
   │  REVERSIBILITY PROBE (D2) · judge-agent = ADVISORY only                       │                    │
   │  in: resolved (loop,tier)+requiredMutationScore+accountabilityOwner ← §2 router│                    │
   │  out: GateResult{pass, signals, moduleArea, diffLines, exceedsClassBudget}     │                    │
   └───────────────┬───────────────────────────────────────────────────────────────┘                  │
                   │ PASS                                                                               │
                   ▼                                                                                    │
   ┌─── APPLY-TIME WRITER (§3.2 · owned by ORCHESTRATION.md) ───┐                                       │
   │  Loop B heal  → commit in author PR (assisted_action row)   │──── writes auto_action row ──────────┘
   │  Loop B quarantine → autonomous bounded merge (§5.1 SEC)    │     (machine | human_approved)
   │  Loop C fix   → PR for HITL (v1: never auto-merge)          │
   │  Loop C auto  → [deferred] business-hours, proven-reversible│
   └─────────────────────────────────────────────────────────────┘

   ═══ CROSS-CUTTING (every node) ═══════════════════════════════════════════════════════════════════
     DURABLE ORCHESTRATOR — AgenticOps Postgres state machine (D1; ORCHESTRATION.md).
        Owns: incident state machine incl. notify_state (CAS), the (loop,tier) ROUTER (§2),
        kill-switch bit (§5), invocation of Loop A / gate / apply-time writer.
     TRUST CONTROLLER (TRUST-CONTROLLER.md) — owns autonomy level per incident-class, OUTCOME-based
        expansion (D6), churn escalator, circuit breaker. Consumes OutcomeEvent (§4). NOT a runtime.
     SECURITY BOUNDARY (SECURITY-THREATMODEL.md) — B1 ingestion auth, per-loop tool authz, sandbox
        egress, service-account least-priv, immutable hash-chained audit log, kill-switch integrity.
     KILL SWITCH (§5) · IMMUTABLE AUDIT LOG · REPLAYABLE WHY-TRACE — everywhere.
```

**Where each named component sits:**
- **Incident Memory** — the pgvector store to the right of the pipeline: read by Loop A for retrieval, written on outcome, and the *projector* that turns resolutions into `OutcomeEvent`s for the Trust Controller (`INCIDENT-MEMORY.md`).
- **Verification Gate** — the per-change, stateless choke point every machine-authored change (Loop B heal, Loop C fix) passes before a human sees it (`VERIFICATION-GATE.md`). It reports signals; it does not decide autonomy.
- **Trust Controller** — the cross-cutting authority on *which incident-class may act at which autonomy level*, driven by outcome data (`TRUST-CONTROLLER.md`). It does not run agents and is not a state machine runtime.
- **Security boundary** — wraps ingestion (B1), the RCA agent's tools, the sandbox, the service accounts, and the audit log (`SECURITY-THREATMODEL.md`).

---

## 2. The router and the numbering crosswalk (resolves coherence #7, #10)

Three numbering systems appear across specs; this section is the **single crosswalk** and every other spec defers to it.

| Concept | Values | Owner | Meaning |
|---|---|---|---|
| **Loop** | A / B / C | this doc §0 | Which loop authored the action. |
| **Tier** (`ARCH-ORIG §5`) | 1 / 2 / 3 / 4 | this doc §3 | Risk/route class of an *action*. The Verification Gate is handed this. |
| **Autonomy level** `L` | L0 / L1 / L2 / L3 | `TRUST-CONTROLLER.md` | How much autonomy a *given incident-class has earned* right now. |

**Crosswalk (L ↔ tier ↔ route):**

| `L` | Meaning | Maps to tier | Route |
|---|---|---|---|
| **L0** | Diagnose only (kill-switch floor; §5) | Tier 1 | Loop A why-trace to human. No write. |
| **L1** | Propose, human merges | Tier 2/3 as PR | Loop B heal / Loop C fix → **PR, human-merged** (`assisted_action`, §3.2). |
| **L2** | Auto-apply, reversible, low blast radius | Tier 2 | Auto-apply *only* when class earned it (Loop C deferred; Loop B flaky quarantine lives here as the one autonomous merge, §5.1). |
| **L3** | Auto-apply, higher blast radius, business-hours, proven-reversible | Tier 3 (never Tier 4) | Loop C only, per-class, earned on outcome data. Tier 4 is **never** autonomous. |

**The router (owned by `ORCHESTRATION.md`, formerly the "Risk Classifier" of `ARCH-ORIG §5`).** No prior spec owned the mapping from the Trust Controller's `AutonomyLevel` to the gate's input tuple. It lives here:

```
router(incident, ractaHypothesis):
  class      := incident.class_key           # (module_area, symptom_signature) — §6 crosswalk
  L          := TrustController.effectiveLevel(class)     # L0..L3 (min across touched areas + churn hold)
  tier       := crosswalk(L)                             # table above
  reqMut     := TrustController.requiredMutationScore(class)   # §3.4; effective bar, not the gate's floor
  owner      := TrustController.accountabilityOwner(class)     # D9 single source, §3.3 / MAJOR #9
  → invoke VerificationGate({ loop, tier, requiredMutationScore: reqMut, accountabilityOwner: owner,
                              parentSHA, fixSHA })
```

The Trust Controller therefore exposes **three** class-keyed reads to the router — `effectiveLevel`, `requiredMutationScore`, `accountabilityOwner` — not just `effectiveLevel`. The gate consumes the resolved tuple and never moves the tier itself (split-brain avoidance, `VERIFICATION-GATE.md` §1). `requiredMutationScore` is sourced from the per-class policy in `trust_controller.yaml` (resolves coherence #13); the gate keeps only a hard floor fallback in `verification.yaml`.

**Diff-stacking / cumulative same-area churn** is a **net-new guard**, owned by `TRUST-CONTROLLER.md` §4.1, fed by the gate's per-run `moduleArea`/`diffLines` fields. It is **not** a stress-test attack — `STRESS-TEST.md` contains only §1–§9, there is no "#11" (resolves coherence #10). Any spec text calling it "attack #11" is a naming defect; the canonical name is **the churn escalator (net-new guard)**. The gate reports the fields; the controller acts on them.

---

## 3. Corrected tier / risk model

This replaces `ARCH-ORIG §5` wholesale. The corrections are the D-decisions made concrete.

### 3.1 The corrected tier table

| Tier | Type | Route (v1) | Autonomy | Corrected gate |
|---|---|---|---|---|
| **1** | Read-only (RCA, diagnosis) | Loop A why-trace → on-call human | Autonomous, zero write (forever) | none — no change authored |
| **2** | Reversible, narrow blast radius | Loop B heal PR (human-gated); Loop C fix PR (HITL, v1) | Auto-apply **only** if class earned L2 on outcome data (deferred); flaky quarantine is the one autonomous L2 merge, bounded server-side (`SECURITY §5.1`) | **mutation score on touched module** + must-fail-on-parent + mandatory repro + proven-reversible + business-hours (below) |
| **3** | External-facing / moderate risk | PR, human merge; auto only if class earned L3 (deferred) | never auto in v1 | full gate + named accountability owner + business-hours + proven-reversible |
| **4** | High-risk / irreversible (migrations, auth, billing, infra, secrets) | Synchronous human plan-approval before any code change | **Never autonomous. Ever.** | protected-path block is hard; agent proposes a plan only |

**What changed from `ARCH-ORIG §5` (each traces to a decision):**
- **Coverage-delta → mutation score (D4).** The original `coverage_delta_non_negative` is deleted. Line/branch coverage answers "was this line executed" — a vacuous test satisfies it trivially. The strength gate is **mutation score on the touched module** (`VERIFICATION-GATE.md` S5), plus the **must-fail-on-parent** anchor (S4): the regression/heal test MUST fail on the parent commit for a behavior reason and pass on the fix commit.
- **Sandbox repro is mandatory, not optional (D2, D3).** The original marked repro optional. Any auto-apply (Loop C) requires the sandbox to *reproduce the signal from real repo state* and the fix to *flip it green* — the only grounded-confidence source. Confidence is grounded booleans, never a self-reported LLM number.
- **Proven-reversible, not "revert commit ready" (D2, STRESS-TEST §9).** A revert of code does not un-run a migration or un-send a webhook. Auto-apply is confined to a positively-attested `side_effect_free_modules` allowlist plus the mechanical reversibility probe (`VERIFICATION-GATE.md` §6).
- **Business-hours gate for any auto-apply (STRESS-TEST §6).** The original async-HITL schedule was perverse: gated tiers slept at night while the ungated Tier 2 ran 24/7 — autonomy inverted from trust. Corrected: **any auto-apply is gated on business-hours** (staffed) unless a class has separately earned off-hours on outcome data. This is owned end-to-end by `HITL-APPROVAL.md` (see §7); the controller enforces business-hours as an L3 hard-gate and, per this correction, extends it to *all* auto-apply.
- **Named accountability owner is a precondition, not a log line (D9).** No auto-apply level (L2+) may exist for a class without a named human owner (§3.3).

### 3.2 The `auto_action` / `assisted_action` write path — who writes what, when (resolves coherence BLOCKER #3, #8)

This was the single most load-bearing gap: the Trust Controller's promotion ladder needs outcome rows for **both** auto-applied changes *and* human-approved L1 merges, but no component owned writing them, and Incident Memory set `auto_action_id = NULL` for human-merged PRs — starving the ladder. Resolved here as the authoritative contract.

**Owner: the apply-time writer, a thin step in `ORCHESTRATION.md`** (the box between the Verification Gate and the repo in §1). It runs at the moment a change *lands* (auto-apply commit, or human-approved PR merge) and inserts exactly one `auto_action` row:

```sql
-- OWNED BY ORCHESTRATION.md apply-time writer. Consumed by Incident Memory (soft FK) + Trust Controller.
CREATE TABLE auto_action (
  action_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id   UUID NOT NULL,
  class_key     TEXT NOT NULL,                 -- (module_area, symptom_signature); §6 crosswalk
  loop          TEXT NOT NULL CHECK (loop IN ('B','C')),   -- A never writes: no change
  applied_by    TEXT NOT NULL CHECK (applied_by IN ('machine','human_approved')),
  applied_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  fix_sha       TEXT NOT NULL,
  parent_sha    TEXT NOT NULL,
  gate_result   JSONB NOT NULL,                -- the GateResult that cleared it (VERIFICATION-GATE.md)
  accountable_owner TEXT NOT NULL,             -- D9 single source materialized here (§3.3)
  module_area   TEXT NOT NULL                  -- for churn + spawn attribution (§6)
);
```

**When each `applied_by` variant is written:**

| Event | `applied_by` | Written by | Notes |
|---|---|---|---|
| Loop B flaky quarantine autonomous merge | `machine` | apply-time writer | bounded merge, `SECURITY §5.1` |
| Loop B test heal merged in author PR (L1) | `human_approved` | apply-time writer, on PR-merge webhook | **the `assisted_action` the ladder needs** — this is the row `TRUST-CONTROLLER.md §2.2` calls load-bearing |
| Loop C fix auto-applied (L2/L3, deferred) | `machine` | apply-time writer | requires proven-reversible + business-hours |
| Loop C fix merged by HITL approver (L1) | `human_approved` | apply-time writer, on PR-merge | approver identity = `accountable_owner` (D9) |

**Incident Memory's rule is corrected accordingly (resolves the "NULL for human-merged" contradiction).** `resolutions.auto_action_id` is set to the `action_id` above for **both** `machine` and `human_approved` landings — *not* NULL for human-merged PRs. Only pure Loop A (no change authored) leaves it NULL. Incident Memory's outcome detectors (recurrence / spawn / revert) and its harm query (`INCIDENT-MEMORY.md §7`) therefore run over **both** `applied_by` variants, which makes `TRUST-CONTROLLER.md`'s `l1_merged_harm_rate` computable (resolves coherence #8).

**The `OutcomeEvent` contract — the one field name (resolves coherence BLOCKER #1).** Incident Memory *projects* resolutions into the controller's event enum. The field is **`actionId`** (not `autoActionId`), because `human_approved` rows are actions too, not auto-actions:

```ts
// EMITTED BY INCIDENT-MEMORY.md projector · CONSUMED BY TRUST-CONTROLLER.md ingestOutcome(ev)
interface OutcomeEvent {
  actionId: string;                 // = auto_action.action_id  (the ONE canonical name)
  kind: 'applied' | 'recurrence' | 'spawn' | 'spawn_contested' | 'revert' | 'matured';
  at: string;                       // ISO
}
```

Both specs are aligned to `actionId`. `ingestOutcome(ev)` reads `ev.actionId`; `outcomeWeight(actionId)` keys on the same.

### 3.3 The D9 accountability owner — single source (resolves coherence MAJOR #9)

Four representations existed (`trust_class.owner`, the gate input `accountabilityOwner`, `resolutions.merged_by`, `accountability.yaml`). The **authoritative source is `trust_class.owner`** in `TRUST-CONTROLLER.md` (enforced by its `CHECK (level < 2 OR owner IS NOT NULL)`), and it propagates thus:

```
trust_class.owner  (authoritative, TRUST-CONTROLLER.md)
   │  read by router (§2) as accountabilityOwner
   ├──► VerificationGate input.accountabilityOwner  → gate HARD-FAILs auto column if null
   ├──► apply-time writer materializes it into auto_action.accountable_owner (frozen, §3.2)
   └──► Incident Memory reads auto_action.accountable_owner (does NOT re-derive from merged_by)
```

`accountability.yaml` (`SECURITY §6`) is the *human-role registry* (who `@sho-loop-b-owner` resolves to), not a second source of the per-class owner. `resolutions.merged_by` becomes a *descriptive* audit field (who clicked merge), not the accountability owner of record. The gate requiring a non-null owner in its input is now backed by a real upstream source, not a decorative field.

### 3.4 The corrected `risk_policy` YAML

This replaces the config block in `ARCH-ORIG §5`. It is split by ownership: `risk_policy.yaml` holds routing/protected-paths; the mutation floor and effective bar live where §2 says (`verification.yaml` floor + `trust_controller.yaml` effective bar).

```yaml
# risk_policy.yaml — routing & hard blocks (owned by ORCHESTRATION.md router, §2)
risk_policy:
  # Tier 4 / protected — NEVER autonomous at any level (ARCH-ORIG §12 kept, hardened server-side §5.2 SEC)
  protected_paths:
    - "src/auth/**"
    - "src/billing/**"
    - "infra/**"
    - "**/migrations/**"
    - "**/*secret*"
    - ".github/**"            # CI config — never machine-authored (SECURITY §5.2)

  # Diff-vs-class budget is a SIGNAL, not a decision (VERIFICATION-GATE.md §5; feeds churn escalator §2)
  class_diff_budget_lines: 15    # exceed → gate emits exceedsClassBudget=true; controller decides

  # Auto-apply (L2+) preconditions — ALL required, corrected from the original §5
  auto_apply_requires:
    - grounded_repro                 # D2/D3 — sandbox reproduced signal AND fix flipped it green (MANDATORY)
    - must_fail_on_parent            # D4 — regression test fails on parent (behavior), passes on fix
    - mutation_score_ge_effective    # D4 — NOT coverage-delta; effective bar from trust_controller.yaml
    - no_weakening                   # heal/fix must not loosen a guard (VERIFICATION-GATE.md §3)
    - proven_reversible              # D2 — side_effect_free allowlist + reversibility probe (VG §6)
    - no_new_dependencies            # diff-policy check; supply-chain (SECURITY §4.4)
    - business_hours                 # STRESS-TEST §6 — staffed hours unless class earned off-hours (HITL-APPROVAL.md)
    - accountability_owner_present   # D9 — gate HARD-FAILs auto column if null (§3.3)
    - full_suite_green

  # Removed from ARCH-ORIG §5 and why:
  #   coverage_delta_non_negative  → REMOVED (D4: mutation score replaces it)
  #   tier2 "auto-apply on green"  → REMOVED (D2/D5: L2 is EARNED per-class on outcome, not default)

  escalation:
    tier3_channel: "telegram:#repairs-review"      # async ladder owned by HITL-APPROVAL.md
    tier4_channel: "telegram:#repairs-critical"
    tier4_sync: true                                # plan-approval before any code change
```

```yaml
# trust_controller.yaml (owned by TRUST-CONTROLLER.md) — the EFFECTIVE per-class bars the router reads
per_class_defaults:
  start_level: L1                    # nothing starts auto; L1 = propose, human merges
  required_mutation_score:           # the effective bar handed to the gate (§2, resolves coherence #13)
    L1: 0.60
    L2: 0.75
    L3: 0.80
  # maturation windows — SINGLE SOURCE (resolves coherence BLOCKER #2; W_confirm DELETED)
  W_recur:  14d
  W_spawn:  14d
  W_revert: 30d
  W_mature: 30d                      # = max(W_recur, W_spawn, W_revert); matured deferred to this
```

### 3.5 The maturation window — one authority (resolves coherence BLOCKER #2)

Incident Memory and the Trust Controller disagreed: a 14-day `W_confirm` would mint `confirmed_good` while the 30-day revert window was still open — the exact boundary race that lets a day-14 recurrence get beaten to the record and banked good, defeating the outcome-based trust defense (STRESS-TEST §3, §8).

**Resolution: `W_confirm` is deleted from Incident Memory. Maturation to `matured`/`confirmed_good` is deferred to `W_mature = max(W_recur, W_spawn, W_revert) = 30d`, owned by `TRUST-CONTROLLER.md`, with harm-wins tie-break** (a recurrence/spawn/revert landing anywhere in the window overrides a pending maturation). Incident Memory's maturation job fires at `applied_at + W_mature`, re-runs the full drift-resistant recurrence check (fingerprint OR `symptom_signature + module_area` OR vector), and only then emits `OutcomeEvent{kind:'matured'}`. Until then a resolution is at most `provisional_human_confirmed` (§3.6), never a positive exemplar.

### 3.6 The outcome-label vocabulary — reconciled (resolves coherence BLOCKER #5)

Loop A treats `provisional_human_confirmed` and `superseded_by_human` as real, retrievable outcomes; Incident Memory's `resolutions.ck_outcome_label` enum did not contain them. Because Loop A's entire anti-rubber-stamp argument (`LOOP-A-SPEC.md §7`) depends on "human tapped confirm, watcher window still open" being *distinguishable* from both `proposed` and `confirmed_good`, the label must exist as stored state. **Resolution: the enum is extended and the projection is fixed.**

```
resolutions.ck_outcome_label ∈ {
  proposed,                    -- RCA emitted, no human verdict yet
  applied,                     -- change landed (machine | human_approved); auto_action row exists
  provisional_human_confirmed, -- ADDED: human tapped "confirm", W_mature window still open (WEAK exemplar only)
  confirmed_good,              -- survived W_mature with no recurrence/spawn/revert (= 'matured'); POSITIVE exemplar
  recurred,                    -- anti-pattern
  reverted,                    -- anti-pattern
  wrong_rca,                   -- human said RCA was wrong; anti-pattern
  superseded                   -- newer resolution replaced this one
}
```

Projection to the controller enum (`INCIDENT-MEMORY.md §5.4`): `provisional_human_confirmed` and `superseded_by_human` (a Loop A trace label) both map to a **neutral** controller view (no `matured`, no positive weight) — `superseded_by_human` records the complete trace on wrong-rollback (`LOOP-A-SPEC.md §6`) but carries no trust weight. Retrieval polarity: `confirmed_good` → strong positive; `provisional_human_confirmed` → **weak context only**; `recurred`/`reverted`/`wrong_rca` → labeled anti-patterns (retrieved as "what not to do", never as a template). This severs memory poisoning at the write side (STRESS-TEST §8, D6): only `confirmed_good` becomes a positive exemplar.

---

## 4. `OutcomeEvent` flow — closing the trust loop (D6)

The trust-expansion runaway (STRESS-TEST §3) is closed by driving expansion off **outcome**, not the absence of a veto:

1. **Incident Memory detects outcomes** over the windows in §3.5 — recurrence (drift-resistant), new-incident-spawn in the touched `module_area` (rename-tracked via git `--follow`, `TRUST-CONTROLLER.md §2.2`, resolves coherence #2), later human revert — and maturation.
2. **It projects each to `OutcomeEvent{actionId, kind, at}`** (§3.2), idempotent and keyed on `actionId`, for both `applied_by` variants.
3. **The Trust Controller folds** the event stream deterministically (`TRUST-CONTROLLER.md §7`: pure fold ordered `(at, kind_rank, actionId)`), computing `confirmed_good_rate`, `l1_merged_harm_rate`, long-run `θ`, and the strict-zero-caused recent window — asymmetric fast-demote / slow-promote.
4. **Expansion is gated on measured outcome, never override-rate alone** (D6). Low override rate is ambiguous ("good" vs "nobody checked") and is not, by itself, a promotion signal.

Because the L1 human-approved rows now carry `actionId` (§3.2), the L1→L2 promotion ladder has a real data source — the bootstrapping gap is closed.

---

## 5. Kill switch — single authoritative bit (resolves coherence MAJOR #6)

Three components enforce freeze (`SECURITY §7.1` at the orchestrator, `TRUST-CONTROLLER §5` forcing effective L0, `VERIFICATION-GATE §7` blocking its downstream actions). They must not disagree. **Resolution: the authoritative kill bit lives in `ORCHESTRATION.md`** (the durable state machine), and all three enforcement points *derive* from it:

- **The bit** is a single row in the AgenticOps Postgres state (`ORCHESTRATION.md`), fail-safe: *absence of a healthy heartbeat = KILL* (`SECURITY §7.1`). Only a signed action from the on-call role over the authenticated HITL channel (`HITL-APPROVAL.md`) can *release* it. No agent tool can toggle it.
- **Trust Controller** reads the bit and forces every class's `effectiveLevel → L0` while engaged; `earned_level` is preserved so RESUME restores the pre-freeze state live (`TRUST-CONTROLLER §5/§6`).
- **Verification Gate** reads the bit as `frozen`: it still evaluates and records the full battery (bookkeeping is never frozen) but blocks **every** downstream action — auto-apply, PR-open, and HITL ping alike (`VERIFICATION-GATE §7`).
- **Orchestrator** checks the bit at **every tier-transition guard**, so a mid-flight agent cannot slip a write through the gap.

Diagnosis-only means exactly: evaluate + record + surface-as-frozen, and nothing that mutates a repo or opens a review. Loop A (read-only) continues; it never writes. The heartbeat-absence-freezes posture accepts a DoS-of-the-switch → global freeze as a safe failure mode (worst case: degraded to copilot).

---

## 6. Shared keys — single-sourced (resolves coherence #12)

`module_area` (repo-relative directory at fixed depth, default 2, e.g. `src/checkout`) is a load-bearing key for the class, the churn escalator, mutation scope, recurrence, and spawn attribution. It is defined **once, by `TRUST-CONTROLLER.md §2.1`** (since it keys autonomy on it); `VERIFICATION-GATE.md §2.0` and `INCIDENT-MEMORY.md §2` reference that definition rather than re-defining it. The `class_key` used by the router (§2) is `(module_area, symptom_signature)` — the same rename-proof pair Incident Memory uses for recurrence, so a refactor cannot launder machine-caused harm.

---

## 7. Guardrails and where autonomy ends

Restated from `ARCH-ORIG §12` and §15, consistent with every component spec. Kept in full; corrected where a decision demanded it.

**Cross-cutting guardrails (every node):**
- **Protected paths and commands never autonomous** — secrets, CI config, infra-as-code, migrations. Enforced *server-side* as a required path-diff CI check (`SECURITY §5.2`), not by prompt and not by CODEOWNERS alone.
- **Rate limits / circuit breaker** — max changes/hour; auto-pause on repeated failures or repeated human rejections; the churn escalator caps cumulative same-area churn (§2, `TRUST-CONTROLLER §4.1`).
- **Immutable, hash-chained, externally-anchored audit log** of every decision and tool call (`SECURITY §7.2`). Every security control writes to it. It *is* the replayable why-trace plus its own integrity record.
- **Proven-reversible for any auto-apply** — positive attestation (`side_effect_free_modules` allowlist) + mechanical probe (`VERIFICATION-GATE §6`), not "a revert commit is ready."
- **Kill switch** — one signed action freezes all autonomy to diagnosis-only (§5).
- **Threat model in scope for v1 (D7)** — authenticated ingestion; all telemetry text treated as untrusted input to the RCA agent; sandbox egress deny-by-default; service-account least-privilege (`SECURITY-THREATMODEL.md`).
- **Named accountability owner is a precondition for any auto-apply tier (D9, §3.3).**

**Where autonomy ends (the system hands to a human, never patches):**
- Problems needing an architectural decision, not a patch.
- Capacity / scaling planning.
- Security incidents — human judgment, never an autopatch.
- Fixes whose logic depends on an ambiguous product/business decision not derivable from code.
- Any incident class where the suite is too weak for verification to mean anything — the mutation gate keeps such a class permanently ineligible for auto-apply (D4, `ARCH-ORIG` principle 6; the permanent squeeze, not a one-time phase gate).
- **Data-dependent incident classes** — not reproducible from schema-only sandbox (`SECURITY §4.2`), so grounded repro never fires; they stay Loop A forever.
- **The async-HITL inversion is closed (STRESS-TEST §6):** any auto-apply is business-hours-gated unless a class separately earned off-hours on outcome data; owned by `HITL-APPROVAL.md`, which also owns the async approval ladder (attack #6) and kill-switch release auth.

**Loop A ends at the hand-off.** It has zero write/exec tools (`SECURITY §3.3`), so even a fully-successful log-borne prompt injection has nothing to weaponize — the primary structural defense of the most-exposed loop.

---

## 8. Build order — robust to the D10 verdict

Measuring the MTTR bottleneck first (D10) is not freezing all work. Almost everything upstream of a *write* serves both branches, so it is built now in parallel with the rolling measurement window (`D10-INSTRUMENT.md`).

| Component | Spec | Build now? | Contingent on D10? |
|---|---|---|---|
| **D10 MTTR instrument** | `D10-INSTRUMENT.md` | **First.** Tier 0, read-only, offline. | It *is* the measurement. |
| Signal layer + authenticated ingestion | `ARCH-ORIG §2`, `SECURITY §2` | Yes | No — serves A, B, C |
| Aggregation & dedup | `ARCH-ORIG §3` | Yes | No |
| Incident Memory (pgvector, outcome-weighted, projector) | `INCIDENT-MEMORY.md` | Yes | No |
| Durable orchestrator (router, notify_state, kill bit, apply-time writer) | `ORCHESTRATION.md` | Yes | No |
| Verification Gate (mutation, must-fail, reversibility, judge-advisory) | `VERIFICATION-GATE.md` | Yes | No — Loop B needs it now; Loop C reuses it |
| Trust Controller (outcome-based, churn, breaker) | `TRUST-CONTROLLER.md` | Yes | No |
| HITL bot + why-trace + audit log + kill switch | `HITL-APPROVAL.md` | Yes | No |
| **Loop A — RCA copilot** | `LOOP-A-SPEC.md` | Build now if **diagnosis-heavy**; defer if remediation-heavy | **Yes** (the v1 product, conditional on D10) |
| **Loop B — test-suite self-healing** | `LOOP-B-SPEC.md` | **Yes, always.** Verdict-independent; contained blast radius; dodges STRESS-TEST §1/§3/§6. | **No** |
| **Loop C — autonomous prod repair** | `LOOP-C-DEFERRED.md` | **No.** | **Yes** — the only truly contingent capability; earned per-class on outcome (D6) |

The D10 verdict decides only **Loop A-now vs deferred** and supplies **Loop C's per-class earn-later evidence**. It does *not* gate Loop B. If diagnosis is the bottleneck, Loop A ships; if remediation is, fix CI/deploy/review friction conventionally first and earn Loop C later per-class — never architect it first (D5, D10).

---

## 9. Metrics (with the harm metric the original omitted)

`ARCH-ORIG §13` was all "did it help" and omitted the one number that makes net-positive provable (STRESS-TEST §9). Corrected set:

**Kept from `ARCH-ORIG §13`:**
- MTTR before/after per incident class — **reported as the within-window split distribution + independent friction proxy** (`D10-INSTRUMENT.md`), never a confounded aggregate before/after trend.
- Escalation rate per tier.
- RCA accuracy — human-confirmed cause matched the agent hypothesis (fed by `provisional_human_confirmed` → `confirmed_good` promotion, `LOOP-A-SPEC.md §7`).
- First-attempt fix success rate.
- Coverage delta over time (frontend/backend) — descriptive only; **never a gate** (the gate is mutation score).
- LLM cost per incident.

**Added — the harm metric (the key safety number, absent from the original):**
- **Incidents caused or worsened by a machine-authored change** — `count(DISTINCT actionId)` where the touched `module_area` shows recurrence, new-incident-spawn (incl. `spawn_contested`), or later human revert, over the §3.5 windows (`INCIDENT-MEMORY.md §7.3`, `TRUST-CONTROLLER.md §6`). Computed over **both** `applied_by` variants (§3.2), so `l1_merged_harm_rate` is real.
- **New-incident-spawn rate in touched files**, rename-tracked (§6).
- **Human-revert-of-machine-change rate.**
- **Trust-transition ledger** — every level change with its outcome justification (append-only, `TRUST-CONTROLLER.md`).

Net-positive is only claimable when the harm metric is bounded *and* the split/friction evidence (`D10-INSTRUMENT.md`) supports the loop being built.

---

## 10. Component spec index

Detail lives in the component specs; this document integrates them, it does not duplicate their internals.

| Spec | Owns |
|---|---|
| `LOOP-A-SPEC.md` | RCA copilot: grounded booleans (G1–G7), correlation_state, delivery CAS, why-trace envelope, no-judge independence via signals. |
| `LOOP-B-SPEC.md` | Test-suite self-healing: A/B/C/D discriminator, flaky quarantine (autonomous), heal (human-gated author-assist), guards, coverage-gaps (later). |
| `LOOP-C-DEFERRED.md` | Deferred production-code repair: per-class earn conditions, repair workers, sandbox repro cycle. **Not built first.** |
| `VERIFICATION-GATE.md` | Per-change stateless signal battery: must-fail-on-parent (S4), mutation score (S5), no-weakening (S6), static/security (S7), reversibility probe (S8), advisory judge (S9). Reports; does not decide autonomy. |
| `INCIDENT-MEMORY.md` | pgvector store, immutable why-trace, outcome-weighted exemplars, drift-resistant recurrence, the `OutcomeEvent` projector, harm query, label vocabulary. |
| `TRUST-CONTROLLER.md` | Per-class autonomy level, outcome-based expansion, churn escalator, circuit breaker, `effectiveLevel`/`requiredMutationScore`/`accountabilityOwner` reads, maturation windows. |
| `SECURITY-THREATMODEL.md` | Ingestion auth, per-loop tool authz, sandbox isolation/egress, service-account least-priv, path-guard CI check, hash-chained audit log, kill-switch integrity, memory-poisoning write-side gate. |
| `D10-INSTRUMENT.md` | The MTTR-bottleneck measurement that gates Loop A-now vs deferred and Loop C earn-later. Tier 0, offline, no write. |
| `ORCHESTRATION.md` | **Keystone (written).** Durable AgenticOps Postgres state machine (D1): incident state incl. `notify_state` (CAS), the router (§2), the apply-time writer (§3.2), the kill bit (§5), invocation of Loop A and the gate. See its revise-addendum for the finalized cross-spec contracts. |
| `HITL-APPROVAL.md` | **Keystone (written).** Async approval ladder (attack #6, incl. business-hours gate for **all** auto-apply — off-hours downgrades to PR; the earn-path is an explicit OPEN item), the Telegram bot Loop A/B/C all use, kill-switch release auth. See its revise-addendum. |

All specs are now written. The two load-bearing keystones — **`ORCHESTRATION.md`** (router, `notify_state`, apply-time writer, kill bit) and **`HITL-APPROVAL.md`** (async ladder, business-hours gate, kill-switch release) — were authored to the contracts this document fixes; each carries a revise-addendum recording the cross-spec finalizations from adversarial review. One capability is deliberately deferred with a written earn-path (`LOOP-C-DEFERRED.md`), and one autonomy feature is an explicit **OPEN** item, not v1: **earned off-hours auto-apply**, which needs net-new Trust-Controller machinery (`HITL-APPROVAL.md` addendum #2, `TRUST-CONTROLLER.md` banner).

---

**Bottom line.** The center of gravity is diagnosis (Loop A) + test-suite healing (Loop B); autonomous production repair (Loop C) is a deferred, per-class, outcome-earned, mutation-gated, business-hours, proven-reversible tail — never architected first. Confidence is grounded booleans, not LLM self-report. Trust expands on outcomes, not the absence of vetoes. Every telemetry input is untrusted, the loop that reads it holds no write tool, every machine-authored change clears a non-LLM signal battery, every auto-apply has a named owner, everything is replayable, one signed command freezes it all, and the harm metric — incidents caused by auto-fixes — is measured, not assumed.
