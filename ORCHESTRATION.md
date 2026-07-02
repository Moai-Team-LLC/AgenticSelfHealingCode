# Orchestration — Durable State Machine, Router, Apply-Time Writer, Kill Bit (spec)

> **Revise addendum — critique fixes applied (authoritative; overrides the body below where they differ).**
> The draft honors every *named* keystone contract; these resolve the integration drifts the adversarial
> review found against sibling specs:
> 1. **Router reads (BLOCKER).** The router calls **three** class-keyed Trust-Controller reads —
>    `effectiveLevel`, `requiredMutationScore`, `accountabilityOwner` (keystone §2). The latter two are
>    hereby added to the `TrustController` interface (propagated in `TRUST-CONTROLLER.md`); the router does
>    not invent them locally.
> 2. **`auto_action` DDL (BLOCKER).** The keystone §3.2 schema (`action_id` PK, `gate_result`,
>    `accountable_owner`, `parent_sha`, `fix_sha`, `class_key`, `module_area`) is **canonical and supersedes**
>    the divergent `auto_action` DDL in `TRUST-CONTROLLER.md` (`id`/`touched_files`/`verdict`/`why_trace_id`).
>    The column delta is propagated back into `TRUST-CONTROLLER.md`; this doc does not fork it.
> 3. **Schema qualifier (BLOCKER).** `auto_action` lives in schema **`orch`** (`orch.auto_action`), written
>    here. `INCIDENT-MEMORY.md`'s `trust.auto_action.id` soft-FKs are superseded → `orch.auto_action.action_id`.
> 4. **`notify_state` CAS (MAJOR).** The orchestrator owns the `notify_state` column and the terminal-event
>    CAS (§3.4); Loop A's `emit()` performs the *send-side* CAS **as the orchestrator-invoked delivery step** —
>    one writer, no double-fire. `LOOP-A-SPEC.md` §8 is the requirement source, not a second owner.
> 5. **Apply-time writer idempotency (MAJOR).** The writer guards its insert on an existing `auto_action` for
>    `(incident_id, fix_sha)` and does `UPDATE resolutions SET auto_action_id=… WHERE auto_action_id IS NULL`.
>    Redelivery is a no-op; Incident Memory's `trg_resolutions_freeze` is the backstop, never a latent throw,
>    and no orphan `auto_action` rows are produced.
> 6. **`toTrustLoop` mapping (MINOR).** `actionKind` `quarantine`→`B_flaky`, `assertion_heal`→`B_heal`,
>    prod fix→`C_repair`, Loop A→`A_rca`. `gate_result` is serialized to JSONB (`JSON.stringify`).
> 7. **Status projection (MINOR).** `VERIFYING`/`LANDED → diagnosed`, `OUTCOME_WATCH → resolved` is the
>    orchestrator's coarse projection over `incident_memory.resolutions.status`, documented as such on both
>    sides (`INCIDENT-MEMORY.md`).

The durable coordination layer. It is the one component that *remembers* — every other
component (`LOOP-A-SPEC.md`, `VERIFICATION-GATE.md`, `TRUST-CONTROLLER.md`,
`INCIDENT-MEMORY.md`) is either stateless-per-call or an append-only ledger; the orchestrator
holds the long-lived, resumable state of an in-flight incident across process restarts and
across the async human wait. It owns four things assigned by the keystone
(`ARCHITECTURE-REFRAMED.md` §10): the **router** (§4, keystone §2), the **`notify_state` store +
CAS** (§3, coherence BLOCKER #4), the **apply-time writer** (§5, keystone §3.2), and the
**kill bit** (§6, keystone §5). It *invokes* Loop A and the Verification Gate; it does not
implement their internals.

It is not a runtime rewrite. Per D1 it **reuses the AgenticOps Postgres durable state
machine** and the existing AgenticMind pgvector instance — no new orchestration engine, no new
datastore. The Claude Agent SDK executes each *step*; AgenticOps Postgres holds the *state
between steps*.

Cross-cutting invariants it honors on every transition (`ARCHITECTURE-REFRAMED.md` §7): a
replayable why-trace, an append to the immutable hash-chained audit log
(`SECURITY-THREATMODEL.md` §7.2), and the kill bit checked at every write-ward transition
(§6). Stack: TS-native (Claude Agent SDK), Postgres+pgvector, GitHub Actions CI, Telegram HITL
bot.

> **Cross-spec reconciliations this doc forces (read before §5).** Three sibling specs predate
> the keystone's contracts and must be amended to match it; where they disagree, the keystone
> wins (`ARCHITECTURE-REFRAMED.md` masthead). This doc integrates by reference *and* names the
> exact deltas to propagate, rather than asserting a false alignment:
> 1. **`auto_action` schema + shape.** The authoritative table is the keystone §3.2 definition,
>    materialized here as **`orch.auto_action`** (§5.1). `TRUST-CONTROLLER.md` (its `auto_action`
>    DDL) and `INCIDENT-MEMORY.md` (its `trust.auto_action.id` soft-FK) carry a *different,
>    pre-keystone* shape and qualifier; §5.1 enumerates the delta and flags it for propagation.
> 2. **Two router reads.** Keystone §2 mandates the Trust Controller expose **three** class-keyed
>    reads; `TRUST-CONTROLLER.md`'s current `interface TrustController` exposes only
>    `effectiveLevel`. §4.1 specifies the two additions (`requiredMutationScore`,
>    `accountabilityOwner`) that `TRUST-CONTROLLER.md` must add to its interface.
> 3. **`notify_state` CAS ownership.** The orchestrator owns the column and the guard; Loop A's
>    `emit()` is the orchestrator-invoked *delivery step* that executes the send-side CAS. §3.5
>    states the single-writer boundary so `LOOP-A-SPEC.md` §8 and this doc agree on who runs the
>    `UPDATE`.

---

## 1. Purpose & the SDK / durable split

The problem the orchestrator solves is the one the SDK does **not**: an incident lives across a
40-minute (or overnight) human wait, and the process running the agent may restart, deploy, or
crash in the middle. A pure in-memory agent loop loses everything on restart precisely at the
step where a human is deliberating. So we split responsibilities:

| Concern | Owner | Lifetime |
|---|---|---|
| Reasoning inside one step (RCA investigation, judge prompt, tool calls) | Claude Agent SDK runner | Ephemeral — one step invocation |
| Which step we are on, for which incident, and all data needed to resume | AgenticOps Postgres state machine (this doc) | Durable — survives restart, survives the HITL wait |
| The "agent working ↔ waiting N min for a human" boundary | **Interrupt/resume point** (§2, §3) | Durable checkpoint |

**The interrupt/resume point.** The state machine executes steps synchronously until it reaches
a state whose next transition depends on an *external* event (a human tap, a PR-merge webhook, a
deploy/rollback event, a maturation timer). At that boundary it **persists the full incident
row and suspends** — no process is blocked, no in-memory promise is held open. The awaited event
arrives later as an inbound message (HITL callback, GitHub webhook, timer tick) that names the
`incident_id`; the orchestrator loads the durable row, verifies the state, and **resumes** from
exactly the persisted state. This is the AgenticOps durable-execution primitive (D1); we do not
reinvent it, we schematize the incident lifecycle onto it (§2).

Nothing here is a new runtime. AgenticOps already provides: durable step records, an inbound
event router keyed on a correlation id, at-least-once event delivery, and cold-restart replay of
the current step. The orchestrator is a *configuration* of that engine plus the four owned
artifacts below.

**At-least-once delivery ⇒ every owned step must be idempotent.** Because AgenticOps redelivers
events at least once, every write this doc owns is written to be a safe no-op on redelivery: the
`notify_state` CAS (§3.3), the apply-time write (§5.3), and the kill guard (§6.3) each key their
effect on a durable condition so a replayed step changes nothing.

**What the orchestrator is NOT.** It does not decide autonomy (that is
`TRUST-CONTROLLER.md`), it does not evaluate change correctness (that is
`VERIFICATION-GATE.md`), it does not run the RCA reasoning (that is `LOOP-A-SPEC.md`), and it
does not own the HITL ladder UI / business-hours logic (that is `HITL-APPROVAL.md`). It
sequences them, holds the state between them, and enforces the kill bit at the seams.

---

## 2. Incident state machine

One row per deduped incident (`incident_memory.incidents.id` is the same id; §2.3). The state
machine below is the orchestrator's *lifecycle* view; `incident_memory.incidents.status`
(`open | diagnosed | resolved | closed`, `INCIDENT-MEMORY.md` §2) is a **coarse projection** of
it — the orchestrator owns the fine-grained `orch_state` and writes the corresponding coarse
`status` back to Incident Memory as a denormalized convenience (§2.2). The two never disagree
because the projection is one-directional and table-driven (§2.2).

### 2.1 States

```
INGESTED       received a deduped Incident Candidate (LOOP-A-SPEC.md §2); nothing done yet
DEDUPED        aggregation/dedup resolved fingerprint + lineage + module_area (ARCH-ORIG §3)
INVESTIGATING  Loop A RCA agent running (LOOP-A-SPEC.md §3); notify_state = 'investigating'
NOTIFIED       why-trace emitted + delivered to on-call over HITL (CAS §3); awaiting human
   ── interrupt/resume boundary: durable wait for a human verdict/action ──
   ┌── human path (Loop A) ─────────────────────────────────────────────────────┐
   │  HUMAN_ACTING   human is acting (rollback / config / manual fix / "investigate")
   └────────────────────────────────────────────────────────────────────────────┘
   ┌── change path (Loop B heal / Loop C fix) ──────────────────────────────────┐
   │  GATING         a machine-authored change is in the Verification Gate (§7)   │
   │  ── interrupt/resume boundary (L1): durable wait for PR-merge webhook ──     │
   │  APPLYING       gate PASS + (auto-apply commit | human-approved merge)       │
   └────────────────────────────────────────────────────────────────────────────┘
VERIFYING      post-apply verification observed to land (fix_flipped_green already proven in the
               gate; here we confirm the commit/merge is on the branch it targeted)
LANDED         change is on the target branch; apply-time writer inserted the auto_action row (§5)
OUTCOME_WATCH  handed to INCIDENT-MEMORY's detectors + maturation (keystone §3.5/§7); window open
CLOSED         terminal. incident resolved (human-resolved, matured, or superseded)
```

`HUMAN_ACTING` and `GATING`/`APPLYING` are **not mutually exclusive across incidents** but are
mutually exclusive *within one incident*: an incident either hands off to a human (Loop A, no
change authored) or carries a machine-authored change through the gate (Loop B/C). The router
(§4) decides which at the `NOTIFIED → …` transition, off the effective autonomy level.

### 2.2 Transitions and the status projection

```
INGESTED     ── dedup done ─────────────────────────────▶ DEDUPED
DEDUPED      ── invoke Loop A (§7); set notify_state='investigating' ▶ INVESTIGATING
INVESTIGATING── why-trace emitted; CAS investigating→notified (§3) ▶ NOTIFIED
INVESTIGATING── terminal ext. event wins the race (§3.4, LOOP-A §8) ▶ CLOSED (superseded_by_human)

NOTIFIED     ── router → Loop A hand-off (L0 / Loop A) ─────────────▶ HUMAN_ACTING
NOTIFIED     ── router → change path, effectiveLevel ≥ L1 ────────▶ GATING
NOTIFIED     ── human resolves before acting ──────────────────────▶ CLOSED

HUMAN_ACTING ── human resolves/rolls back ────────────────────────▶ CLOSED   (Loop A: no auto_action)
HUMAN_ACTING ── human opens/authors a change for the loop ────────▶ GATING

GATING       ── GateResult.pass=false | frozen ───────────────────▶ back to HUMAN_ACTING (with reason)
GATING       ── pass, L2/L3 auto (kill-bit clear, §6) ────────────▶ APPLYING (auto-apply commit)
GATING       ── pass, L1 → open PR; suspend for merge webhook ────▶ APPLYING (on human PR-merge)

APPLYING     ── commit/merge observed on target branch ───────────▶ VERIFYING
VERIFYING    ── landed confirmed; apply-time writer inserts row (§5) ▶ LANDED
LANDED       ── hand to Incident Memory outcome detectors ────────▶ OUTCOME_WATCH
OUTCOME_WATCH── matured | recurred | reverted | superseded ───────▶ CLOSED
```

**Status projection (one-directional, table-driven):**

| `orch_state` | `incident_memory.incidents.status` |
|---|---|
| INGESTED, DEDUPED | `open` |
| INVESTIGATING, NOTIFIED | `open` |
| HUMAN_ACTING, GATING, APPLYING | `open` |
| VERIFYING, LANDED | `diagnosed` |
| OUTCOME_WATCH | `resolved` |
| CLOSED | `closed` |

The orchestrator is the *sole* writer of `orch_state`; it derives and writes `status` on every
transition via this table. **`status` is the orchestrator's coarse projection, not an
independently-authored field** — `INCIDENT-MEMORY.md` §2 must document `status` as *"the
orchestrator's coarse projection of `orch.incident_state.orch_state` per the ORCHESTRATION.md
§2.2 table"* so the projection semantics are stated on both sides (the `status` column's schema
lives in Incident Memory; its *meaning* is set here). Incident Memory treats `status` as
read-mostly denormalized state and never derives autonomy or outcome from it — those come from
`resolutions.outcome_label` and the `OutcomeEvent` stream (`INCIDENT-MEMORY.md` §4/§5).

**Deliberate choice: a *landed* change projects to `diagnosed`, not `resolved`, until
`OUTCOME_WATCH`.** `status='diagnosed'` covers both "RCA done, no change authored" (Loop A) and
"change landed, verification confirmed, outcome window not yet open." An incident is only
projected `resolved` once it enters `OUTCOME_WATCH`, i.e. once Incident Memory owns its
maturation. This keeps `status` from claiming success (`resolved`) for a fix whose harm windows
(keystone §3.5) are still open — the same conservatism the maturation model enforces
everywhere. Because `status` is coarse and consumers must not branch on the diagnosed/resolved
distinction for trust or outcome, this collapse is safe; the fine distinction lives in
`orch_state` and `resolutions.outcome_label`.

### 2.3 Durable row

```sql
-- OWNED BY ORCHESTRATION.md. Lives in the AgenticOps Postgres instance (D1), schema `orch`.
CREATE TABLE orch.incident_state (
  incident_id     UUID PRIMARY KEY,               -- = incident_memory.incidents.id (soft ref, D1)
  orch_state      TEXT NOT NULL,                  -- the fine-grained state (§2.1)
  notify_state    TEXT NOT NULL DEFAULT 'investigating'
                    CHECK (notify_state IN ('investigating','notified')),   -- §3
  loop            TEXT CHECK (loop IN ('A','B','C')),   -- set at the NOTIFIED→ routing decision
  class_key       TEXT,                           -- (module_area, symptom_signature); keystone §6
  resolved_tier   SMALLINT,                       -- 1..4, the router's output (§4); NULL until routed
  parent_sha      TEXT,
  fix_sha         TEXT,
  why_trace_id    UUID,                           -- the Loop A / gate why-trace (audit + replay)
  awaiting        TEXT,                            -- what external event we are suspended on:
                                                   --  'human_verdict'|'pr_merge'|'deploy_event'|NULL
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_orch_state    ON orch.incident_state (orch_state);
CREATE INDEX ix_orch_awaiting ON orch.incident_state (awaiting) WHERE awaiting IS NOT NULL;
```

On cold restart the orchestrator scans `awaiting IS NOT NULL` rows and re-arms their event
subscriptions — this is the durable resume (§1). Rows in a non-terminal `orch_state` with no
`awaiting` are actively-running steps that AgenticOps replays.

---

## 3. `notify_state` (resolves coherence BLOCKER #4)

`LOOP-A-SPEC.md` §8 requires the human-facing payload be sent **exactly once**, race-safe
against a human resolving the incident (including a *wrong* rollback) while the RCA is still in
flight. That race is "did the human resolve, or did we send?" — and it must be a single
serialized decision, or we double-notify (or annotate a message that was never delivered). The
orchestrator owns the store and the compare-and-set that makes it atomic; Loop A's `emit()` is
the delivery step that executes it (§3.5).

### 3.1 The column and its enum

`notify_state` is a column on `orch.incident_state` (§2.3), **not** a second table — it is a
per-incident scalar updated in the same transaction as the send decision.

```
notify_state ∈ { 'investigating', 'notified' }
  investigating  RCA in flight; no payload delivered yet (initial value at DEDUPED→INVESTIGATING)
  notified       the CAS won; the payload was (or is being) delivered exactly once
```

It is deliberately a two-value enum, distinct from and narrower than `orch_state`. `orch_state`
tracks the whole lifecycle; `notify_state` guards *one* event — first-and-only delivery. Keeping
them separate is what lets a terminal external event (human resolve) short-circuit `orch_state`
to `CLOSED` while `notify_state` independently records whether a message ever went out.

### 3.2 Relationship to `incidents.status`

`notify_state` has **no** projection into `incident_memory.incidents.status`. It is
orchestration-internal delivery bookkeeping; Incident Memory neither reads nor mirrors it. The
only external surface is the HITL bot, which learns the outcome of the CAS (sent / cancelled) as
the return value of the delivery call (§3.4/§3.5), never by polling the column.

### 3.3 The CAS (the anti-double-notify guarantee)

Delivery is a conditional single-statement update. The payload is sent **iff** the row
transitions `investigating → notified` in the same durable step; the send is dispatched only
when the CAS reports it changed exactly one row.

```sql
-- Atomic claim of the right-to-send. Runs inside the delivery step's transaction (§3.5).
UPDATE orch.incident_state
   SET notify_state = 'notified',
       orch_state   = 'NOTIFIED',
       awaiting     = 'human_verdict',
       updated_at   = now()
 WHERE incident_id  = $incident_id
   AND notify_state = 'investigating'    -- CAS guard: only the first caller wins
 RETURNING incident_id;
```

- **1 row returned** → this caller won the CAS. It (and only it) dispatches the HITL payload,
  then commits. At-least-once delivery + the `notified` state make retries idempotent: a
  redelivered send step re-runs the same `UPDATE`, matches zero rows (already `notified`), and
  becomes a no-op.
- **0 rows returned** → someone/something already moved the incident past `investigating`. Do
  **not** send. Either a concurrent delivery won, or a terminal external event resolved the
  incident first (§3.4).

### 3.4 Race with human resolution (incl. wrong rollback)

The terminal external events (`deploy/rollback observed`, human `resolve`, human `ack-resolve`)
compete with the send for the same row. Whichever transaction commits first wins, because both
gate on `notify_state = 'investigating'`:

```sql
-- Terminal-event handler (rollback/resolve observed) — claims the SAME guard the send needs.
UPDATE orch.incident_state
   SET orch_state   = 'CLOSED',
       notify_state = 'notified',     -- consume the send-right so no payload can still fire
       awaiting     = NULL,
       updated_at   = now()
 WHERE incident_id  = $incident_id
   AND notify_state = 'investigating'
 RETURNING incident_id;
```

- **Terminal event wins (this CAS returns a row; the send later returns 0):** cancel the send.
  Per `LOOP-A-SPEC.md` §8, the orchestrator still drives Loop A's `emit()` path to **persist the
  COMPLETE why-trace** (not a partial), labeled `superseded_by_human`, recording what the human
  actually did. This is the wrong-rollback safety: if the human rolled back the wrong deploy, the
  correct RCA is on record for the re-alert. `orch_state → CLOSED`.
- **Send wins (send CAS returns a row; the terminal event later returns 0):** the payload is
  delivered; the incident is `NOTIFIED`, `awaiting='human_verdict'`. A terminal event observed
  **after** this does not re-run the guarded CAS (it matches 0 rows); instead it takes the
  post-notify edit path — the orchestrator edits the Telegram message in place to
  `✅ resolved by <human> (<action>) — RCA below was FYI` and transitions `NOTIFIED → CLOSED`
  (or `→ HUMAN_ACTING` if the human instead chose to act). No second notification.

Both branches are a single serialized decision on one row under one guard column — the
BLOCKER #4 requirement. The `superseded_by_human` trace label maps to a **neutral** controller
view and to `wrong_rca`/neutral retrieval polarity (keystone §3.6, `INCIDENT-MEMORY.md`
§5.2/§5.4 — the latter's table row *"— (Loop A human verdict) → `wrong_rca` … not sent"*); it
carries no trust weight and is never a positive exemplar.

### 3.5 Single-writer boundary with Loop A's `emit()`

`LOOP-A-SPEC.md` §8 states the durable state machine subscribes to incident-state changes and
that `emit()` "deliver[s] the enriched payload via a compare-and-set on incident
`notify_state`." Those are the same CAS, not two. The boundary, stated so the two specs agree on
who runs the `UPDATE`:

- **The orchestrator owns** the `notify_state` column (§3.1), the SQL guard (the exact `UPDATE`
  in §3.3/§3.4), and the *terminal-event* CAS (§3.4). It is the sole writer of the column.
- **`emit(trace)` is the orchestrator-invoked delivery step** (§7.1): the orchestrator hands it
  the persisted trace and the incident context, and `emit()` executes the **send-side** CAS
  (§3.3) inside that step's transaction, then dispatches the HITL payload iff the CAS returned a
  row. `emit()` does not invent its own column or its own guard; it runs the orchestrator's.
- There is therefore exactly **one** writer per branch: the send-side CAS is run by `emit()` (as
  the orchestrator's delivery step); the terminal-event CAS is run by the orchestrator's
  event handler. Both target the one column under the one guard, so they serialize — no
  double-fire, no orphaned annotation.

`LOOP-A-SPEC.md` §8 should reference this section for the column/guard definition rather than
re-describe the CAS mechanics, so the ownership is single-sourced here.

---

## 4. The router (implements keystone §2)

The router is the concrete function formerly called the "Risk Classifier" (`ARCH-ORIG §5`). It
runs at the `NOTIFIED → {HUMAN_ACTING | GATING}` decision for a change-bearing loop, and again
before any re-gate. It maps the Trust Controller's three class-keyed reads into the exact input
tuple `VERIFICATION-GATE.md` consumes. It **never** moves the tier itself after the gate is
handed it (split-brain avoidance, `VERIFICATION-GATE.md` §1); it resolves the tuple once, per
change candidate.

### 4.1 Inputs it reads and the crosswalk it applies

Keystone §2 mandates the Trust Controller expose **three** class-keyed reads to the router.
`TRUST-CONTROLLER.md`'s current `interface TrustController` exposes only `effectiveLevel` (plus
`ingestOutcome`/`reconcile`/`outcomeWeight`/`kill`/`resume`/`status`). **`TRUST-CONTROLLER.md`
must add the two reads below to its interface** so the router's calls resolve; they are pure
functions of already-stored state and add no new authority:

- `effectiveLevel({loop, actionKind, touchedFiles})` → `L0..L3`. **Already exists.** The hard
  ceiling: the **minimum** across all touched `module_area`s, already folding in any active
  churn hold (`TRUST-CONTROLLER.md` §4.1, its `effectiveLevel` contract). The router may never
  exceed it.
- `requiredMutationScore(classKey)` → `number`, the *effective* mutation bar. **To be added.**
  It returns the per-class bar from `trust_controller.yaml` (`per_class_defaults.required_mutation_score[L]`
  resolved for the class's current level, keystone §3.4). This is the effective bar handed to the
  gate, **not** the gate's hard floor in `verification.yaml`.
- `accountabilityOwner(classKey)` → `string | null`, `= trust_class.owner`. **To be added.** The
  **single source** of the D9 owner (keystone §3.3); it reads the `trust_class.owner` column
  directly, so there is no second owner store.

`L ↔ tier` is the keystone §2 crosswalk, applied verbatim:

| `L` (effectiveLevel) | tier | route |
|---|---|---|
| L0 | 1 | Loop A why-trace → human; **no change authored** (router returns `human_handoff`) |
| L1 | 2 or 3 (as PR) | Loop B heal / Loop C fix → **PR, human-merged** (`applied_by='human_approved'`, §5) |
| L2 | 2 | auto-apply, reversible, low blast radius (Loop B flaky quarantine; Loop C deferred) |
| L3 | 3 (never 4) | auto-apply, business-hours, proven-reversible (Loop C only, earned) |

Tier 4 (protected paths, keystone §3.4 `risk_policy.yaml`) is **never** produced as an
autonomous route: a diff touching a protected path is forced to synchronous human plan-approval
regardless of `effectiveLevel`, and the gate additionally hard-blocks it server-side
(`SECURITY-THREATMODEL.md` §5.2 path-guard).

**The loop-name adapter `toTrustLoop`.** The router's inbound `loop` is the keystone §0 alphabet
`'A' | 'B' | 'C'`; the Trust Controller keys on the finer `Loop =
'A_rca' | 'B_flaky' | 'B_heal' | 'C_repair'` (`TRUST-CONTROLLER.md` Interfaces). The disambiguator
is `actionKind`, which the candidate always carries. The mapping is total and deterministic:

| `loop` | `actionKind` | → `toTrustLoop` |
|---|---|---|
| `A` | any | `A_rca` |
| `B` | `quarantine` | `B_flaky` |
| `B` | `assertion_heal`, `selector_heal`, `snapshot_heal`, … (any non-`quarantine` Loop B kind) | `B_heal` |
| `C` | any (`null_guard`, `bounds_fix`, …) | `C_repair` |

`toTrustLoop` throws on an `actionKind` it cannot classify for the given `loop` (fail-closed: an
unclassifiable action never silently maps to the more-permissive class). The class key the two
other reads take is the incident's `class_key = (module_area, symptom_signature)` (keystone §6),
carried on the candidate; `TrustController.effectiveLevel` derives its own class internally from
`toTrustLoop(loop, actionKind) × module_area` (`trust_class.class_key = hash(loop, action_kind,
module_area)`), so the router passes it the structured input, not the pre-hashed key.

### 4.2 The function

```ts
// OWNED BY ORCHESTRATION.md. Deterministic; no LLM. Called by the orchestrator at
// NOTIFIED→routing for a change-bearing candidate. Returns EITHER a human hand-off OR the
// exact tuple VERIFICATION-GATE.md consumes.
interface RouteDecision {
  route: 'human_handoff' | 'gate';
  loop: 'A' | 'B' | 'C';
  tier: 1 | 2 | 3 | 4;
  // present iff route === 'gate' — the VerificationGate input tuple, verbatim (VERIFICATION-GATE.md §1/§5)
  gateInput?: {
    loop: 'B' | 'C';
    tier: 1 | 2 | 3 | 4;
    requiredMutationScore: number;        // effective bar from TrustController (keystone §2, §3.4)
    accountabilityOwner: string | null;   // trust_class.owner (keystone §3.3); gate HARD-FAILs auto column if null
    parentSHA: string;
    fixSHA: string;
  };
}

async function route(input: {
  loop: 'A' | 'B' | 'C';
  actionKind: string;                 // e.g. 'quarantine' | 'assertion_heal' | 'null_guard'
  touchedFiles: string[];
  parentSHA: string;
  fixSHA: string;
  classKey: string;                   // (module_area, symptom_signature), keystone §6
}): Promise<RouteDecision> {
  // 1. Protected-path hard block (keystone §3.4 risk_policy.protected_paths) → Tier 4, human only.
  if (touchesProtectedPath(input.touchedFiles)) {
    return { route: 'human_handoff', loop: input.loop, tier: 4 };
  }

  // 2. Loop A is diagnose-only by construction — never a change candidate.
  if (input.loop === 'A') {
    return { route: 'human_handoff', loop: 'A', tier: 1 };
  }

  // 3. Trust Controller reads (the three class-keyed reads — keystone §2, §4.1).
  const L      = await TrustController.effectiveLevel({          // min across areas + churn hold
                   loop: toTrustLoop(input.loop, input.actionKind),
                   actionKind: input.actionKind,
                   touchedFiles: input.touchedFiles });
  const reqMut = await TrustController.requiredMutationScore(input.classKey);   // effective bar (§4.1)
  const owner  = await TrustController.accountabilityOwner(input.classKey);     // = trust_class.owner

  // 4. L → tier crosswalk (keystone §2). L0 = diagnose only → no change authored.
  if (L === 0 /* L0 */) {
    return { route: 'human_handoff', loop: input.loop, tier: 1 };
  }
  const tier = L === 1 ? tierForL1(input) /* 2 or 3, opened as PR */
             : L === 2 ? 2
             : /* L3 */  3;             // never 4

  // 5. Hand the gate the resolved tuple. The gate consumes it and never moves the tier.
  return {
    route: 'gate', loop: input.loop, tier,
    gateInput: {
      loop: input.loop as 'B' | 'C', tier,
      requiredMutationScore: reqMut,
      accountabilityOwner: owner,      // may be null; the gate hard-FAILs the auto column if so (D9)
      parentSHA: input.parentSHA, fixSHA: input.fixSHA,
    },
  };
}
```

### 4.3 Who calls it, when

- **The orchestrator** calls `route()` once at `NOTIFIED → routing` for a change-bearing loop
  (Loop B heal candidate, or a Loop C fix candidate), and again if a candidate is re-gated after
  a human revision. Loop A candidates route to `human_handoff` immediately (Tier 1) and never
  touch the gate.
- The returned `gateInput` is passed **unmodified** to `VerificationGate.evaluate(...)` (§7). The
  gate echoes `loop`/`tier` back in `GateResult` for audit (`VERIFICATION-GATE.md` "Produces")
  but is architecturally forbidden from choosing them.
- `effectiveLevel` is a hard ceiling: whatever the RCA/agent "wants," the router cannot request a
  higher autonomy column than the controller returned. This one-directional authority is what
  makes the Trust Controller the single throttle (keystone §4, `TRUST-CONTROLLER.md` Interfaces).

---

## 5. The apply-time writer (implements keystone §3.2)

The single most load-bearing seam: the L1→L2 promotion ladder needs outcome rows for **both**
auto-applied changes *and* human-approved L1 merges, but no component owned writing them, and
Incident Memory previously set `auto_action_id = NULL` for human-merged PRs — starving the
ladder (keystone §3.2, coherence BLOCKER #3). The apply-time writer closes it. It is a **thin,
deterministic step in the orchestrator** — the box between the Verification Gate and the repo in
keystone §1 — that runs at `VERIFYING → LANDED`, i.e. the moment a change *lands*.

### 5.1 The table — `orch.auto_action` (keystone §3.2 supersedes the sibling shapes)

The authoritative `auto_action` shape is the keystone §3.2 definition. This doc materializes it
as **`orch.auto_action`** (it is written here, so it lives in the orchestrator's `orch` schema
alongside `incident_state` and `kill_switch`). This is **not** "reused verbatim" from
`TRUST-CONTROLLER.md` — that spec carries a *different, pre-keystone* table, and the qualifier
`trust.auto_action` used by `INCIDENT-MEMORY.md`'s soft-FK is likewise pre-keystone. The
keystone wins; the deltas are enumerated below and flagged for propagation.

```sql
-- AUTHORITATIVE SHAPE = ARCHITECTURE-REFRAMED.md §3.2. Materialized here as orch.auto_action.
-- Written by ORCHESTRATION.md apply-time writer. Consumed by INCIDENT-MEMORY.md (soft FK)
-- + TRUST-CONTROLLER.md. Canonical PK is action_id; emitted OutcomeEvent field is actionId.
CREATE TABLE orch.auto_action (
  action_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id   UUID NOT NULL,
  class_key     TEXT NOT NULL,                 -- (module_area, symptom_signature); keystone §6
  loop          TEXT NOT NULL CHECK (loop IN ('B','C')),   -- A never writes: no change
  applied_by    TEXT NOT NULL CHECK (applied_by IN ('machine','human_approved')),
  applied_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  fix_sha       TEXT NOT NULL,
  parent_sha    TEXT NOT NULL,
  gate_result   JSONB NOT NULL,                -- the GateResult that cleared it (VERIFICATION-GATE.md)
  accountable_owner TEXT NOT NULL,             -- D9 single source materialized here (keystone §3.3)
  module_area   TEXT NOT NULL,                 -- for churn + spawn attribution (keystone §6)
  -- Idempotency backstop for at-least-once redelivery (§5.3). One landed change = one row.
  UNIQUE (incident_id, fix_sha)
);
CREATE INDEX ix_auto_action_class  ON orch.auto_action (class_key, applied_at);
CREATE INDEX ix_auto_action_area   ON orch.auto_action (module_area, applied_at);  -- churn + spawn
```

> **Delta vs the sibling specs — to be propagated (keystone wins).**
> - **`TRUST-CONTROLLER.md`** currently defines its own `auto_action` with PK **`id`** (not
>   `action_id`), plus `touched_files text[]`, `verdict`, `verdict_at`, `why_trace_id` — and
>   **without** `gate_result`, `accountable_owner`, `parent_sha`, `fix_sha`. That is a different
>   table. Reconciliation: it must (a) rename its consumer references `id → action_id`, (b) treat
>   this `orch.auto_action` as the single source of truth for the row, and (c) relocate the
>   controller-owned mutable fields (`verdict`, `verdict_at`) — which are the *controller's* fold
>   state, not the writer's — into a controller-side table keyed on `action_id`, since this
>   writer only ever inserts the immutable landing facts and never mutates `verdict`. `why_trace_id`
>   is carried on `orch.incident_state.why_trace_id` (§2.3) and in the audit payload; the
>   controller reads it from there rather than from `auto_action`.
> - **`INCIDENT-MEMORY.md`** soft-FKs to `trust.auto_action.id` (its `resolutions.auto_action_id`
>   and `detected_outcomes.auto_action_id` comments). Reconciliation: those refer to
>   **`orch.auto_action.action_id`**; the comments must be updated to the `orch.` qualifier and
>   the `action_id` column name. The FK stays *soft* (cross-schema, no hard constraint) exactly as
>   Incident Memory already documents.
> - **`OutcomeEvent` / `assisted_action`.** The emitted event field is `actionId` (keystone
>   §3.2 `OutcomeEvent = { actionId, kind, at }`); where the projector says `autoActionId`, that
>   is the same column. The `assisted_action` the ladder needs (`TRUST-CONTROLLER.md` §2.2) is
>   **not** a separate table: it is an `orch.auto_action` row with `applied_by='human_approved'`.

### 5.2 Exactly when a row is inserted

The writer inserts **exactly one** `orch.auto_action` row per landed machine-authored change, at
`VERIFYING → LANDED`, discriminated by how it landed:

| Landing event | Trigger | `applied_by` | `loop` | Notes |
|---|---|---|---|---|
| Loop B flaky quarantine autonomous merge | auto-apply commit observed on branch | `machine` | `B` | bounded merge, `SECURITY-THREATMODEL.md` §5.1 |
| Loop B test heal merged in author PR (L1) | **PR-merge webhook** (GitHub) | `human_approved` | `B` | **the `assisted_action` the ladder needs** — the load-bearing row (`TRUST-CONTROLLER.md` §2.2) |
| Loop C fix auto-applied (L2/L3, deferred) | auto-apply commit observed on branch | `machine` | `C` | requires proven-reversible + business-hours (keystone §3.1) |
| Loop C fix merged by HITL approver (L1) | **PR-merge webhook** | `human_approved` | `C` | approver identity is *descriptive*; `accountable_owner` is `trust_class.owner` (§5.4) |

- For the **auto-apply** variants (`machine`), the writer runs immediately in the same durable
  step that observes the commit landing on the target branch (`APPLYING → VERIFYING → LANDED`).
- For the **L1 human-merged** variants (`human_approved`), the incident sat at `APPLYING`
  suspended on `awaiting='pr_merge'` (§2.3, the interrupt/resume boundary). The GitHub PR-merge
  webhook is the resume event; on it the writer inserts the row with `applied_by='human_approved'`.
  This is what makes the human's L1 diff a *scored action* — the exact evidence the L1→L2 ladder
  consumes.

Loop A never reaches this writer: it authors no change, its route is `human_handoff`, and its
resolution stays `auto_action_id = NULL` (`INCIDENT-MEMORY.md` §2 note).

### 5.3 Idempotent write; `resolutions.auto_action_id` set for BOTH variants

The writer, in the same transaction as the insert, sets
`incident_memory.resolutions.auto_action_id = <the new action_id>` for the incident's current
non-superseded resolution — for **both** `machine` and `human_approved` landings. This corrects
the pre-keystone "NULL for human-merged PRs" contradiction (keystone §3.2). Consequence, made
explicit so it is not re-broken:

- Incident Memory's outcome detectors (recurrence/spawn/revert) and its harm query
  (`INCIDENT-MEMORY.md` §7.3) run over **both** `applied_by` variants, so
  `TRUST-CONTROLLER.md`'s `l1_merged_harm_rate` (its §6) is computable.
- Only pure Loop A (rca-only, no change authored) leaves `auto_action_id = NULL`.

**Idempotency vs the freeze trigger (fixes the redelivery hazard).** `INCIDENT-MEMORY.md` §2
installs `trg_resolutions_freeze`, which raises if `resolutions.auto_action_id` is changed once
non-NULL. Because AgenticOps delivers the landing event at-least-once (§1), a naive redelivery
would insert a *second* `auto_action` row and then attempt to overwrite `auto_action_id` — which
the freeze trigger would reject, leaving an orphan row and a failed step. The writer is therefore
idempotent by construction:

1. The insert uses `ON CONFLICT (incident_id, fix_sha) DO NOTHING` against the
   `UNIQUE (incident_id, fix_sha)` constraint (§5.1) and `RETURNING` — a redelivery inserts no
   second row and re-reads the existing `action_id`.
2. The `resolutions` UPDATE is guarded `WHERE auto_action_id IS NULL`, so a redelivery matches
   zero rows and never trips the freeze trigger. The freeze trigger is thus the *backstop*, not a
   latent exception in the happy path.

```ts
// OWNED BY ORCHESTRATION.md. Runs at VERIFYING→LANDED, in ONE transaction. Deterministic + idempotent.
async function applyTimeWrite(ctx: {
  incidentId: string; classKey: string; loop: 'B' | 'C';
  appliedBy: 'machine' | 'human_approved';
  fixSHA: string; parentSHA: string; moduleArea: string;
  gateResult: GateResult;              // the PASSing GateResult (VERIFICATION-GATE.md)
  accountableOwner: string;            // = trust_class.owner (keystone §3.3); NON-NULL for any auto column
}): Promise<{ actionId: string }> {
  return withTx(async (tx) => {
    // 1. Insert-or-get. UNIQUE(incident_id, fix_sha) makes redelivery a no-op (§5.1).
    const inserted = await tx.query(
      `INSERT INTO orch.auto_action
         (incident_id, class_key, loop, applied_by, fix_sha, parent_sha,
          gate_result, accountable_owner, module_area)
       VALUES ($1,$2,$3,$4,$5,$6, $7::jsonb, $8,$9)     -- gate_result serialized to JSONB (§5.1)
       ON CONFLICT (incident_id, fix_sha) DO NOTHING
       RETURNING action_id`,
      [ctx.incidentId, ctx.classKey, ctx.loop, ctx.appliedBy, ctx.fixSHA, ctx.parentSHA,
       JSON.stringify(ctx.gateResult), ctx.accountableOwner, ctx.moduleArea]);
    const actionId = inserted.rows[0]?.action_id
      ?? (await tx.query(
            `SELECT action_id FROM orch.auto_action WHERE incident_id=$1 AND fix_sha=$2`,
            [ctx.incidentId, ctx.fixSHA])).rows[0].action_id;

    // 2. Set the soft FK on the CURRENT non-superseded resolution — for BOTH variants (keystone
    //    §3.2). Guarded WHERE auto_action_id IS NULL so redelivery never trips the freeze trigger.
    await tx.query(
      `UPDATE incident_memory.resolutions
          SET auto_action_id = $1, updated_at = now()
        WHERE incident_id = $2 AND superseded_by IS NULL
          AND outcome_label <> 'superseded'
          AND auto_action_id IS NULL`,
      [actionId, ctx.incidentId]);

    await appendAudit(tx, { incidentId: ctx.incidentId, actor: applyActor(ctx.appliedBy),
      action: 'merge', payload: { action_id: actionId, fix_sha: ctx.fixSHA,
      applied_by: ctx.appliedBy, gate_pass: ctx.gateResult.pass } });   // audit (§7.2 SECURITY)
    return { actionId };
  });
}
```

The writer's DB role must hold INSERT on `orch.auto_action`, UPDATE on
`incident_memory.resolutions` (the `auto_action_id`/`updated_at` columns), and INSERT on
`audit_log` — a **cross-schema grant** (`orch` + `incident_memory` + the audit schema) required
for the single transaction above. This is the one component with write access spanning both
schemas; every other consumer of `orch.auto_action` is read-only on it.

### 5.4 Owner is materialized, not re-derived; provenance is frozen

`accountable_owner` is materialized (frozen) from `trust_class.owner` at write time via the
router's `accountabilityOwner` read (§4.1), **not** re-derived from the PR approver (keystone
§3.3). `resolutions.merged_by` remains a *descriptive* audit field (who clicked merge), never the
accountability owner of record. Incident Memory's `trg_resolutions_freeze` (its §2) additionally
freezes `merged_by`, `diff_ref`, and `auto_action_id` once set — so the soft FK this writer sets
cannot be silently rewritten after assignment; §5.3's `WHERE auto_action_id IS NULL` guard means
the writer only ever writes it once, in agreement with that trigger.

---

## 6. The kill bit (implements keystone §5)

The keystone resolves the three-way freeze disagreement (coherence MAJOR #6) by making the
orchestrator hold the **single authoritative kill bit**, from which all three enforcement points
*derive*. This section is that bit.

### 6.1 The single row, heartbeat-fail-safe

```sql
-- OWNED BY ORCHESTRATION.md. The ONE authoritative kill bit. Schema `orch`.
CREATE TABLE orch.kill_switch (
  id                SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- singleton row
  engaged           BOOLEAN NOT NULL DEFAULT false,   -- explicit engage state
  last_heartbeat_at TIMESTAMPTZ,                        -- switch-service liveness (SECURITY §7.1)
  engaged_at        TIMESTAMPTZ,
  engaged_by        TEXT,                               -- signed on-call identity (HITL-APPROVAL.md)
  released_by       TEXT,                               -- dual-attribution on release (SECURITY §7.1)
  released_at       TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO orch.kill_switch (id, engaged) VALUES (1, false) ON CONFLICT DO NOTHING;
```

**Effective kill is fail-safe (absent heartbeat = KILL):**

```
killed := engaged
        OR last_heartbeat_at IS NULL
        OR (now() - last_heartbeat_at) > heartbeat_ttl     -- default 30s (SECURITY §7.1)
```

If the switch service cannot be confirmed alive, the system degrades to Loop A read-only —
offline == frozen (`SECURITY-THREATMODEL.md` §7.1). An attacker cannot *enable* autonomy by
taking the switch offline; the accepted failure mode is a DoS-of-the-switch → global freeze
(worst case: degraded to copilot, never unsafe writes — keystone §5).

**Release is the sensitive direction and is not agent-reachable:**

- Only a **signed action from the on-call role over the authenticated HITL channel**
  (`HITL-APPROVAL.md`), MFA-backed, dual-attributed, may set `engaged=false`
  (`SECURITY-THREATMODEL.md` §7.1). Engaging is likewise a signed on-call action (or any
  heartbeat-fail, which cannot be "released" until the service is healthy again).
- **No agent tool can toggle the bit.** It is out-of-band from the pipeline the agent runs in; a
  steered agent cannot re-enable itself (`SECURITY-THREATMODEL.md` §7.1). There is no
  `kill`/`resume` tool registered with any Agent SDK runner.

### 6.2 Derivation — three enforcement points, one bit, cannot disagree

All three consumers read this one bit; none holds its own independent freeze flag:

- **TrustController** reads `killed` and, while true, forces every class's `effectiveLevel → L0`
  (`TRUST-CONTROLLER.md` §5). `earned_level` is preserved so RESUME restores the live pre-freeze
  state (`TRUST-CONTROLLER.md` §5/§6). Because the router (§4) reads `effectiveLevel`, a kill
  makes every `route()` return `human_handoff` at Tier 1 — no gate input with a write column is
  even producible.
- **VerificationGate** reads `killed` as its `frozen` flag (`VERIFICATION-GATE.md` §7): it still
  evaluates and records the full battery (bookkeeping is never frozen) but returns
  `frozen: true, pass: false` and blocks **every** downstream action — auto-apply, PR-open, and
  HITL ping alike.
- **The orchestrator's own tier-transition guard** (below) checks `killed` at **every**
  write-ward transition, so a mid-flight agent cannot slip a write through the gap between the
  controller read and the gate read. This is the placement `SECURITY-THREATMODEL.md` §7.1 defers
  to this doc ("see ORCHESTRATION.md for where these transition guards live").

Because all three derive from the same row, they cannot disagree: there is no second freeze bit
to fall out of sync. The controller forcing L0 and the gate returning `frozen` are two *views* of
the one bit, not two independent decisions.

### 6.3 The tier-transition guard

```ts
// Checked by the orchestrator BEFORE every write-ward transition. Diagnosis-only = evaluate +
// record + surface-as-frozen, and NOTHING that mutates a repo or opens a review (keystone §5).
const WRITE_WARD: OrchState[] = ['GATING', 'APPLYING', 'VERIFYING', 'LANDED'];

async function guardedTransition(incidentId: string, from: OrchState, to: OrchState) {
  if (WRITE_WARD.includes(to)) {
    const killed = await killBit.isKilled();     // reads orch.kill_switch (fail-safe, §6.1)
    if (killed) {
      await appendAudit(null, { incidentId, actor: 'system', action: 'kill_switch',
        payload: { blocked_transition: { from, to }, reason: 'frozen' } });   // §7.2 SECURITY
      // Do NOT enter a write-ward state. Route back to human as 'frozen' (never open a review artifact).
      return transitionTo(incidentId, 'HUMAN_ACTING', { note: 'frozen' });
    }
  }
  return transitionTo(incidentId, to);
}
```

- Read-ward transitions (`INGESTED→…→NOTIFIED`, `→HUMAN_ACTING` for Loop A, `→OUTCOME_WATCH`,
  `→CLOSED`) are **not** gated by the kill bit: Loop A (read-only) continues under kill, and
  bookkeeping/outcome maturation keeps ticking (`TRUST-CONTROLLER.md` §5,
  `INCIDENT-MEMORY.md` §9). Kill freezes *action*, not *diagnosis or bookkeeping*.
- The check is at the *transition to* the write-ward state, so an incident that entered `GATING`
  before a kill and reaches `APPLYING` after it is stopped at the `→APPLYING` guard — a mid-flight
  agent gets no write.

### 6.4 Kill / resume flow (orchestrator side)

```
On ENGAGE (signed on-call action over HITL-APPROVAL.md, or heartbeat-fail):
  1. Set orch.kill_switch.engaged = true (signed path) — or leave engaged=false but let
     heartbeat-fail make `killed` true (offline path). Append audit 'kill_switch'.
  2. TrustController.kill(reason, by) → forces effective L0 for all classes (its §5), earned_level intact.
  3. In-flight incidents: the next guardedTransition into a write-ward state routes them to
     HUMAN_ACTING/'frozen'. No incident is force-killed mid-step; the step completes, the NEXT
     write-ward transition is refused.

On RELEASE (signed on-call action over HITL-APPROVAL.md; NEVER automatic):
  1. Set orch.kill_switch.engaged = false, released_by/at (dual attribution). Append audit.
  2. TrustController.resume(by) → restores each class to min(earned_level_now, predicate_recheck())
     reading earned_level LIVE (its §5/§6) — a freeze-time demotion is honored, never re-raised.
  3. Suspended incidents resume from their persisted orch_state (§1 durable resume); the gate's
     `frozen` view flips off with the same bit.
```

The orchestrator never *resumes* autonomy on its own — release is exclusively the on-call signed
action, matching keystone §5 and `SECURITY-THREATMODEL.md` §7.1.

---

## 7. Invocation & audit

### 7.1 Who invokes Loop A and the gate

The orchestrator is the sole invoker of both — they never call each other, so the sequencing and
the kill-bit seams live in one place:

- **Loop A** — at `DEDUPED → INVESTIGATING`, the orchestrator sets `notify_state='investigating'`
  and calls `investigate(candidate)` (`LOOP-A-SPEC.md` Interfaces). Loop A runs its read-only
  tool loop and returns a `WhyTrace`; the orchestrator then invokes Loop A's `emit(trace)` **as
  its delivery step**, which executes the orchestrator-owned send-side CAS (§3.3, §3.5) and
  dispatches the HITL payload iff the CAS won. Loop A holds no write tools and is unaffected by
  the kill bit (it is L0/read-only by construction).
- **The Verification Gate** — at `GATING`, the orchestrator (having passed the kill guard, §6.3)
  calls `VerificationGate.evaluate(gateInput)` with the router's resolved tuple (§4). It consumes
  the returned `GateResult`:
  - `pass && !frozen && auto column` → `guardedTransition(→ APPLYING)` (auto-apply commit).
  - `pass && !frozen && L1` → open the PR, transition `→ APPLYING` but **suspend** on
    `awaiting='pr_merge'` until the merge webhook (§5.2).
  - `!pass || frozen` → route back to `HUMAN_ACTING` with `GateResult.blockedReason`; never open
    a review artifact under `frozen` (`VERIFICATION-GATE.md` §7).
  - The gate echoes `moduleArea`/`diffLines`/`exceedsClassBudget`; the orchestrator forwards these
    to the Trust Controller, which owns the **churn escalator (net-new guard)**
    (`TRUST-CONTROLLER.md` §4.1, keystone §2). The orchestrator does not act on them itself — it
    only ensures the next `route()` reflects any resulting churn hold (folded into
    `effectiveLevel`, §4.1).

### 7.2 Every transition + tool call appends to the immutable audit log

The audit log DDL, hash chain, append-only grants, and external anchoring are owned by
`SECURITY-THREATMODEL.md` §7.2 (`audit_log`, `prev_hash`/`hash`, `sho_app` INSERT-only,
independent-identity verifier). The orchestrator is a *writer* to it — it does not redefine it.
Every state transition and every step it drives appends one record:

| Orchestrator event | `audit_log.action` | payload highlights |
|---|---|---|
| any `orch_state` transition | `state_transition` | `{from, to, incident_id, why_trace_id}` |
| Loop A / gate step dispatch | `tool_call` | `{step, loop, tier}` |
| CAS delivery (send won) | `notify` | `{notify_state:'notified'}` |
| PR opened | `pr_open` | `{loop, tier, fix_sha}` |
| apply-time write (§5) | `merge` | `{action_id, applied_by, fix_sha, gate_pass}` |
| kill guard blocked a write-ward transition | `kill_switch` | `{blocked_transition, reason:'frozen'}` |
| engage / release | `kill_switch` | `{engaged, engaged_by \| released_by}` |

Because the log **is** the replayable why-trace plus its own integrity record
(`SECURITY-THREATMODEL.md` §7.2, keystone §7), every incident is replayable end-to-end: the
`orch.incident_state` row gives the current state, and the audit-log records for its
`incident_id` give the ordered path to it, each hash-chained to the previous. The
grounded-repro/gate/why-trace payloads live in the record `payload` JSONB, so an auditor can
re-derive *why* a change landed (or was blocked) from the log alone. Security-relevant rows
(auto-merges, kill toggles) are anchored off-system on the short cadence
`SECURITY-THREATMODEL.md` §7.2 mandates.

---

## Interfaces & files

- **Owns / defines here:** `orch.incident_state` (§2.3, incl. `notify_state`), `orch.auto_action`
  (§5.1, materializing the keystone §3.2 shape), the router (§4), the apply-time writer (§5),
  `orch.kill_switch` (§6.1) and the tier-transition guard (§6.3).
- **Reuses (D1):** the AgenticOps Postgres durable state machine (durable steps, inbound event
  router, cold-restart replay) and the AgenticMind pgvector instance. No new runtime, no new
  datastore.
- **Reuses, does not redefine:** the `OutcomeEvent` `{ actionId, kind, at }` shape and the
  `auto_action` column set from `ARCHITECTURE-REFRAMED.md` §3.2 (materialized as
  `orch.auto_action`, §5.1); the `audit_log` DDL + hash chain from `SECURITY-THREATMODEL.md`
  §7.2.
- **Forces on sibling specs (keystone wins; §5.1 + §4.1 detail):** `TRUST-CONTROLLER.md` adds
  `requiredMutationScore` / `accountabilityOwner` to its interface and reconciles its
  `auto_action` shape to `orch.auto_action` (PK `action_id`, controller-mutable `verdict` fields
  relocated); `INCIDENT-MEMORY.md` updates its `trust.auto_action.id` soft-FK references to
  `orch.auto_action.action_id` and documents `incidents.status` as the ORCHESTRATION §2.2
  projection; `LOOP-A-SPEC.md` §8 references §3 for the `notify_state` column/guard.
- **Calls:** `investigate(candidate)` and `emit(trace)` (`LOOP-A-SPEC.md`);
  `TrustController.effectiveLevel` / `requiredMutationScore` / `accountabilityOwner` / `kill` /
  `resume` (`TRUST-CONTROLLER.md`); `VerificationGate.evaluate(gateInput)`
  (`VERIFICATION-GATE.md`).
- **Writes (cross-schema, §5.3):** `orch.auto_action` (§5), `incident_memory.resolutions.auto_action_id`
  (§5.3), `incident_memory.incidents.status` (the coarse projection, §2.2), `audit_log` (§7.2
  SECURITY).
- **Consumed by:** the HITL bot (`HITL-APPROVAL.md`) for delivery/verdict/merge callbacks and
  kill-switch engage/release; the Trust Controller (reads the `orch.auto_action` rows this writer
  produces); Incident Memory (soft FK from `resolutions.auto_action_id` and its outcome
  detectors over both `applied_by` variants).
- **Honors kill switch:** the single `orch.kill_switch` bit is authoritative; TrustController
  (forces L0), VerificationGate (`frozen`), and the tier-transition guard (§6.3) all derive from
  it and cannot disagree. Release is a signed on-call action over `HITL-APPROVAL.md` only.

**Bottom line.** The Agent SDK does the thinking; AgenticOps Postgres holds the state so an
incident survives a restart and a 40-minute human wait. `notify_state` + one CAS — owned here,
executed by Loop A's `emit()` as the delivery step — make delivery exactly-once and race-safe
against a (possibly wrong) human rollback. The router turns the Trust Controller's three
class-keyed reads (two of which `TRUST-CONTROLLER.md` must add) into the gate's exact input tuple
and never moves the tier after. The apply-time writer inserts one idempotent `orch.auto_action`
row on both auto-apply and L1 human-merge — and sets `resolutions.auto_action_id` for both, under
a `WHERE … IS NULL` guard that respects Incident Memory's freeze trigger — so the L1→L2 ladder
finally has data. One fail-safe kill bit, released only by a signed on-call action, forces L0 in
the controller, `frozen` in the gate, and a refused transition in the orchestrator — three views,
one bit, checked at every write-ward seam. Everything appends to the hash-chained audit log, so
every landing and every freeze is replayable.
