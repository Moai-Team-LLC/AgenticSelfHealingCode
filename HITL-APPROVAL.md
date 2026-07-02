# HITL Approval Layer — Async Ladder, Business-Hours Gate, Telegram Bot (spec)

> **Revise addendum — critique fixes applied (authoritative; overrides the body below where they differ).**
> 1. **D9 owner on edit/merge (BLOCKER).** When a human edits or merges, `auto_action.accountable_owner`
>    remains **`trust_class.owner`** (keystone §3.3) — *not* the editing/merging human. The acting human is
>    recorded only in the descriptive `resolutions.merged_by` / `verdict_by` audit field. Delete "the person
>    who changed it owns it."
> 2. **Off-hours has no earn path in v1 (BLOCKER — behavior change).** There is **no** `hasEarnedOffHours`
>    read; the Trust Controller exposes only the three keystone §2 reads. v1 rule: **outside staffed business
>    hours, ANY auto-apply (L2/L3) downgrades *unconditionally* to a propose-and-wait L1 PR.** "Earned
>    off-hours autonomy" is an **explicit OPEN cross-spec item**, not a v1 feature — it requires net-new
>    Trust-Controller machinery (an off-hours-tagged dimension on `OutcomeEvent`, a `hasEarnedOffHours(classKey)`
>    read, and `K_off`/`D_min_off` config) that does not exist today. This closes attack #6 conservatively,
>    which is correct. Drop the `earned_off_hours_classes` YAML mirror (finding #7); if audit visibility is
>    wanted, snapshot the decision into the immutable audit log, not a checked-in file.
> 3. **`notify_state` CAS owner (MAJOR).** Owned by **`ORCHESTRATION.md` §3**; `LOOP-A-SPEC.md` §8 is only the
>    requirement source. This layer consumes what the CAS delivered.
> 4. **This layer sets no durable outcome label (MAJOR).** The Approve button **emits the human verdict
>    event**; `INCIDENT-MEMORY.md` persists `provisional_human_confirmed` onto `resolutions` (it owns that
>    table). The §1 invariant is scoped to: HITL never writes `confirmed_good`/`matured`.
> 5. **`auto_action` has no `pending` column (MAJOR).** The row is inserted **immutably** (keystone §3.2). The
>    *outcome verdict* for that `actionId` is `pending` (weight 0, `TrustController.outcomeWeight`) until the
>    watcher matures it — "pending" is a projection-side verdict, not a row state.
> 6. **`approval_request` tier/loop invariant (MAJOR).** Add `CHECK (tier < 3 OR loop = 'C')` — Loop B is
>    test-files-only and never reaches Tier 3/4. Tier-4 rows are **plan-approvals** with null
>    `fix_sha`/`parent_sha` and `loop='C'`.
> 7. **`superseded_by_human` (MINOR).** `approval_request.state='SUPERSEDED'` is request-cancellation; the
>    `superseded_by_human` *outcome label* is authored by Loop A / Incident Memory, never here.

Owns the human-in-the-loop channel for the whole system — the one Telegram surface Loop A, Loop B,
and (deferred) Loop C all deliver into — and closes the one attack the coherence ledger still marks
STILL OPEN: **STRESS-TEST attack #6, the perverse off-hours schedule.** This is the keystone §3.1/§7
business-hours correction, owned here end-to-end.

The controlling facts this spec honors, none of which it re-decides:
- The two loops + deferred Loop C, the L↔tier↔loop crosswalk, and the router live in
  `ARCHITECTURE-REFRAMED.md` §0/§2. This spec is a *consumer* of the resolved `(loop, tier, L)` tuple,
  never its author.
- The `auto_action` table, `applied_by`, `accountable_owner`, and the apply-time writer are owned by
  `ORCHESTRATION.md` (keystone §3.2). The button→verdict path here writes a *provisional human verdict on
  the trace*; it never inserts an `auto_action` row and never writes a durable positive outcome label.
- Autonomy is owned by `TRUST-CONTROLLER.md`. Nothing a human taps in Telegram raises a class's level
  (D6, `TRUST-CONTROLLER.md` §4.3). The router reads exactly the **three** class-keyed surfaces the
  keystone enumerates — `effectiveLevel` / `requiredMutationScore` / `accountabilityOwner`
  (`ARCHITECTURE-REFRAMED.md` §2); this spec adds no fourth read (§2.4).
- The kill bit lives in `ORCHESTRATION.md`, heartbeat-fail-safe; release is only via a signed on-call
  action over this authenticated channel (keystone §5, `SECURITY-THREATMODEL.md` §7.1). No agent tool
  can toggle it (§6 below).
- Delivery race-safety is the `notify_state` **store + CAS owned by `ORCHESTRATION.md` §3** (keystone §1);
  `LOOP-A-SPEC.md` §8 states the requirement the CAS satisfies. This spec renders and acts on what that
  CAS delivered; it does not implement the CAS.

Cross-refs: `ARCHITECTURE-ORIGINAL.md` §8 (the async-default posture originates here); `LOOP-A-SPEC.md`
§7/§8 (compressed why-trace payload, `provisional_human_confirmed`, `superseded_by_human`,
`suspicious_content_flag`, D7); `ORCHESTRATION.md` §3/§5 (notify_state CAS, interrupt/resume, apply-time
writer, `accountable_owner` = `trust_class.owner`); `INCIDENT-MEMORY.md` §5 (owns `resolutions` and its
label lifecycle, incl. `provisional_human_confirmed`); `TRUST-CONTROLLER.md` §3.5/§3.6/§4.1/§4.2/§4.3/§6
(owner precondition, churn escalator, contraction breaker, expansion invariant, harm alerts);
`SECURITY-THREATMODEL.md` §6/§7.1 (accountability registry, kill-switch integrity).

---

## 0. Scope and non-ownership boundaries

This layer owns four things and only four:

1. the durable **async approval ladder** (`approval_request` + timers, §3);
2. the **business-hours gate** that closes attack #6 by binding *all* auto-apply, not only Tier 3 (§2);
3. the **Telegram bot** every loop delivers into — rendering + verdict actuation (§4);
4. the **kill-switch release** authentication path (§6).

It is a *consumer*, never an author, of everything else. In particular it never:
- inserts an `auto_action` row — the apply-time writer does (`ORCHESTRATION.md` §3.2/§5);
- materializes `accountable_owner` — that is `trust_class.owner`, frozen by the apply-time writer
  (`ORCHESTRATION.md` §5.4, keystone §3.3), regardless of who tapped Approve or edited the diff;
- persists a durable outcome label into `resolutions` — `INCIDENT-MEMORY.md` §5 owns that table and its
  freeze trigger; this layer **emits the human-verdict event** and Incident Memory records the label;
- raises a class's autonomy level — the Trust Controller does, on outcomes only (D6);
- holds any tool that can toggle the kill bit (§6).

---

## 1. Purpose & the async-default posture

**Synchronous blocking breaks on real infrastructure.** A human approval that holds a request open —
a live socket, a pending agent step, a short-lived GitHub App token (`SECURITY-THREATMODEL.md` §5.3,
~1h) — dies the moment any of them time out. At 3am the human answers in 40 minutes; the token expired
at minute 60, the socket at minute 5, the agent step was reaped long before. Synchronous HITL is a
correctness bug, not a UX preference (`ARCHITECTURE-ORIGINAL.md` §8).

**The default is a durable queue with a timeout and an escalation ladder.** Every approval is a row in
`approval_request` (Postgres, the AgenticOps instance — D1), owned by the durable state machine, and
survives process restarts. The Telegram bot is a *view and an actuator* over that row, never the source
of truth. If the bot process dies mid-approval, the row is intact; a new bot instance re-renders it from
state. If a verdict arrives after the token that would have applied it expired, the state machine
re-mints a token at apply time — the human's verdict and the machine's write authority are decoupled in
time by construction.

**Coordination with `ORCHESTRATION.md` interrupt/resume.** An approval is a durable *interrupt* on the
incident's state machine:

```
orchestrator reaches a tier-2/3/4 gate that needs a human
   → INTERRUPT: persist approval_request{state=OPEN}, arm the ladder timer (§3), return control
   → the incident's durable state parks at awaiting_human; NO socket, NO agent step held open
   → (later) a verdict CAS lands on approval_request  OR  the ladder timer fires
   → RESUME: the state machine wakes on the durable event, re-mints any token it needs,
             and takes exactly one transition (apply / open-PR / reject / re-queue)
```

The orchestrator checks the kill bit at every one of these tier-transition guards (keystone §5,
`SECURITY-THREATMODEL.md` §7.1), so a verdict that resumes into a *write* cannot slip past a freeze that
engaged while the request sat open. This spec owns the ladder, the rendering, the verdict contract, and
the business-hours gate; `ORCHESTRATION.md` owns the state machine those interrupts park in and the
apply-time writer they eventually resume into.

**What this layer never does (invariant, scoped precisely):** it never applies a change itself (the
apply-time writer does, `ORCHESTRATION.md` §5), never raises autonomy (the Trust Controller does, on
outcomes), holds no tool that can toggle the kill bit (§6), and **never writes a durable *positive*
outcome label** (`confirmed_good` / `matured`) — those are earned only by the outcome watcher surviving
`W_mature` (`INCIDENT-MEMORY.md` §5.3, keystone §3.5). It *does* originate the human's **provisional**
verdict at trace close; that verdict is an event this layer emits and `INCIDENT-MEMORY.md` persists as the
`provisional_human_confirmed` label (§4.2) — a weak, neutral-to-the-controller state, never a positive
exemplar. HITL is the source of the verdict *event*; Incident Memory is the owner of the *stored label*.

---

## 2. THE OPEN ATTACK #6 — the business-hours gate (load-bearing)

### 2.1 The perverse schedule, stated exactly

`STRESS-TEST.md` §6: the original async-HITL schedule inverts autonomy from trust. At night and on
weekends the **human-gated** tiers go dark — Tier 3's secondary approver is asleep, Tier 4's
auto-reject-on-timeout means the most dangerous class simply *doesn't happen* until someone wakes — while
the **ungated auto-apply** path (an L2-class action) keeps running 24/7. So exactly when incidents spike
and humans sleep, the only thing still acting autonomously is the class trusted *least* (auto-apply
without a live human), and the classes we trust enough to gate are the ones that stall. The autonomy
profile is upside-down relative to the trust profile. This is the attack the coherence ledger marks
STILL OPEN. It is closed here.

### 2.2 The business-hours model

A **staffed window** is a per-team, per-timezone schedule of when a human on-call can actually answer.
It is config, checked in, never prompt-derived, and evaluated deterministically server-side.

```yaml
# hitl-business-hours.yaml — owned by HITL-APPROVAL.md; loaded by the orchestrator at boot, drift=alert
business_hours:
  # Multiple teams, each with its own timezone and staffed windows. An incident's team is resolved
  # from module_area → owning team (the same accountability.yaml role registry, SECURITY §6).
  teams:
    checkout:
      timezone: "Europe/Nicosia"
      staffed:                      # local wall-clock, inclusive start / exclusive end
        - { days: [mon,tue,wed,thu,fri], start: "09:00", end: "19:00" }
      holidays_calendar: "cy-public-holidays"     # dates in here are NEVER staffed
      secondary_on_call: "@checkout-secondary"
    platform:
      timezone: "America/New_York"
      staffed:
        - { days: [mon,tue,wed,thu,fri], start: "08:00", end: "18:00" }
      follow_the_sun: ["checkout"]   # if platform is unstaffed, checkout's window may cover (see below)
      holidays_calendar: "us-federal"
      secondary_on_call: "@platform-secondary"
  default_policy: downgrade         # outside any staffed window → downgrade to propose-and-wait (§2.3)
```

`isStaffed(team, at)` is a pure function: resolve `at` into the team's timezone, reject if the date is in
the team's holiday calendar, else true iff `at` falls in a `staffed` interval. `follow_the_sun` lets one
team's window cover another's incident *only when the covering team is itself staffed* — never widening
total coverage beyond a live human. Multi-area incidents (a diff touching two areas → two teams) require
**all** touched teams' windows to be staffed to count as staffed; otherwise the safe floor applies
(mirrors the Trust Controller's min-across-areas rule, `TRUST-CONTROLLER.md` §7 multi-area resolution).

There is deliberately **no** `earned_off_hours_classes` list in this YAML. A checked-in mirror of
autonomy state would be a second source of truth for something the keystone spent §3.3 collapsing to one
source — and in v1 nothing computes it (§2.4). Off-hours autonomy state, if and when it exists, is read
live and snapshotted into the immutable audit log at decision time (§2.4), never cached in config.

### 2.3 The rule — ANY auto-apply is business-hours-gated (keystone §3.1/§7)

The correction is not "gate Tier 3." It is: **any auto-apply, at any autonomy level, is gated on staffed
business hours.** This is the exact inversion fix — the ungated 24/7 path is what the original left
running, so the gate must bind *it*, not only the human tiers.

```
On a resolved action tuple (loop, tier, L, class_key, touched_areas) that would AUTO-APPLY
(i.e. effectiveLevel ∈ {L2, L3} — the machine lands the change without a human merge):

  team      := teamsFor(touched_areas)
  staffed   := ALL(t in team: isStaffed(t, now()))

  if staffed:                       → proceed as an auto-apply (still ALL other gates: keystone §3.4)
  else:                             → DOWNGRADE to an L1 PR that WAITS FOR A HUMAN.
        - the action is authored as a PR exactly as an L1 PROPOSE would be (assisted_action path);
        - an approval_request{state=OPEN, downgraded_from=L, reason='off_hours'} is enqueued (§3);
        - it enters the SAME async ladder as any Tier-2/3 approval and sits until a human returns
          to staffed hours (or the ladder escalates per §3);
        - NOTHING auto-applies. The 24/7 ungated path is gone.
```

This makes autonomy track trust across the clock: off-hours, the machine's default reach *shrinks* to
"propose and wait," which is the opposite of the original inversion. The downgrade is a *routing*
decision made at the gate boundary; it never mutates the class's earned level (that is outcome-driven,
owned by the Trust Controller) — it only changes what *this action, right now, off-hours* is permitted to
do. When the human returns, the parked PR is a normal L1 merge, and its landing produces the usual
`human_approved` `auto_action` row via the apply-time writer (`ORCHESTRATION.md` §5), feeding the ladder
like any other L1 action.

Tier 4 is out of scope of any off-hours concession regardless: it is **never autonomous** (keystone
§2/§3.1). Off-hours, a Tier-4 action is still a synchronous plan-approval request; the ladder's Tier-4
rule (§3.3) applies.

**v1 posture: the downgrade is unconditional off-hours.** In v1 there is no "earned off-hours" escape
hatch — *every* auto-apply outside staffed hours downgrades to propose-and-wait. This is the strictly
safe closure of attack #6 and it depends on nothing that does not already exist. The earn path is a
deliberate future extension with an explicit, unmet cross-spec dependency (§2.4).

### 2.4 Earned off-hours autonomy — DEFERRED, with an explicit unmet cross-spec dependency

It is tempting to let a class *buy* off-hours autonomy the way it earns any autonomy — on outcome
evidence — so that a class with a long clean off-hours track record need not stall every night. That is
the right long-term shape, but **it cannot be built in v1 without net-new machinery in
`TRUST-CONTROLLER.md`, and it is not built here.** The keystone punted this ("a class may separately earn
off-hours on outcome data", §3.1/§7) without assigning an owner or a data source; this section names the
gap precisely rather than papering over it.

What an earn path would *require* (none of which exists today — verified against `TRUST-CONTROLLER.md`):

- **An off-hours dimension on `OutcomeEvent`.** The current event is `{ actionId, kind, at }` (keystone
  §3.2, `TRUST-CONTROLLER.md` interfaces) — it carries **no** flag for whether the underlying action
  occurred off-hours. Folding an off-hours-only track record is impossible without tagging each event
  with that dimension, which means a schema change in the projector (`INCIDENT-MEMORY.md`) and the event
  contract (keystone §3.2).
- **A fourth Trust Controller read.** The router reads exactly three class-keyed surfaces today
  (`effectiveLevel` / `requiredMutationScore` / `accountabilityOwner`, keystone §2). An earn path needs a
  fourth, e.g. `hasEarnedOffHours(classKey): Promise<boolean>`, computed by the controller as its normal
  auto-apply predicate (`TRUST-CONTROLLER.md` §3.2) restricted to the off-hours-tagged subset. **This read
  does not exist**, and adding it is a `TRUST-CONTROLLER.md` change, not something this layer can define or
  "read the result of."
- **Off-hours-specific config** in `trust_controller.yaml`: a longer dwell for the off-hours subset (harm
  surfaces more slowly overnight, fewer eyes), e.g. `D_min_off = 2 × D_min`, and a count bar `K_off`.
  These do not exist today.
- **The same standing invariants** if it is ever built: owner precondition (`TRUST-CONTROLLER.md` §3.6,
  D9 — no owner, no off-hours grant); asymmetric fast revocation (a single caused-incident, or a churn
  hold via `TRUST-CONTROLLER.md` §4.1, clears the grant immediately); and **never granted by a tap** — no
  approval verdict and no low-override-rate reading may set it (`TRUST-CONTROLLER.md` §4.3).

> **OPEN CROSS-SPEC ITEM (owner: `TRUST-CONTROLLER.md`, blocked on keystone §3.2 event contract).**
> "Earned off-hours autonomy" needs (a) an off-hours dimension added to `OutcomeEvent` and the
> `INCIDENT-MEMORY.md` projector, (b) a new `hasEarnedOffHours` read on `TRUST-CONTROLLER.md`, and
> (c) `K_off` / `D_min_off` config. Until all three land, this layer downgrades **every** off-hours
> auto-apply unconditionally (§2.3). This gate has one clean extension point: replace the `else` branch
> of §2.3 with `elif TrustController.hasEarnedOffHours(class_key): proceed`. It is intentionally the
> single line that changes, and it stays disabled until the controller can answer it truthfully.

Because the v1 downgrade is unconditional, attack #6 is closed **without** this earn path: off-hours, the
previously-ungated 24/7 auto-apply is gone (it becomes propose-and-wait), and the gated tiers no longer go
dark because the ladder actively chases a human (§3.3). Autonomy tracks trust across the clock in v1; the
earn path only *loosens* the night-time stall later, and only once the controller owns the evidence.
**Attack #6 is closed.**

---

## 3. The approval ladder

### 3.1 Queue schema

```sql
-- OWNED BY HITL-APPROVAL.md. Durable approval queue; the Telegram bot is a view over it.
-- Lives in the AgenticOps Postgres instance (D1). The bot never holds authoritative state.
CREATE TABLE approval_request (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id      UUID NOT NULL,
  class_key        TEXT NOT NULL,                       -- (module_area, symptom_signature); §6 crosswalk
  loop             TEXT NOT NULL CHECK (loop IN ('B','C')),   -- A never queues an approval: it only advises
  tier             SMALLINT NOT NULL CHECK (tier IN (2,3,4)),
  requested_level  SMALLINT NOT NULL,                   -- the L the router resolved (may be > applied path)
  downgraded_from  SMALLINT,                            -- set iff off-hours business-hours downgrade (§2.3)
  reason           TEXT,                                -- 'off_hours' | 'tier3' | 'tier4' | 'churn_escalate'
  why_trace_id     UUID NOT NULL,                       -- the immutable trace this decision is about
  fix_sha          TEXT,                                -- proposed change; NULL for a Tier-4 plan-approval
  parent_sha       TEXT,                                -- NULL for a Tier-4 plan-approval (no authored diff)
  team             TEXT NOT NULL,                       -- resolved owning team (§2.2)
  state            TEXT NOT NULL DEFAULT 'OPEN'
                     CHECK (state IN ('OPEN','ESCALATED','APPROVED','REJECTED','EXPIRED','SUPERSEDED')),
  primary_approver TEXT,                                 -- on-call at enqueue time
  current_approver TEXT,                                 -- moves to secondary on escalation
  verdict_by       TEXT,                                 -- who acted (DESCRIPTIVE audit; identity from §6);
                                                         --   NOT the accountability owner of record (§4.3)
  verdict_at       TIMESTAMPTZ,
  telegram_msg_ref TEXT,                                 -- chat/message id for in-place edits (§4)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  escalate_at      TIMESTAMPTZ,                          -- next ladder timer fire (§3.2/§3.3)

  -- Crosswalk invariant, enforced at the one place this layer newly owns (keystone §2):
  --   Loop B is test-files-only and NEVER reaches Tier 3/4; only Loop C reaches Tier 3/4.
  --   So any Tier-3/4 approval MUST be loop='C'; Tier 2 may be 'B' or 'C'.
  CONSTRAINT tier_requires_loop_c CHECK (tier < 3 OR loop = 'C'),

  -- A Tier-4 request is a synchronous PLAN-approval only — the agent proposes a plan, it does not
  -- author code (keystone §3.1) — so it legitimately carries no diff.
  CONSTRAINT tier4_is_plan_no_diff CHECK (tier <> 4 OR (fix_sha IS NULL AND parent_sha IS NULL)),

  -- a request is terminal once state ∉ {OPEN, ESCALATED}; the state machine resumes on that transition
  CONSTRAINT terminal_has_verdict
    CHECK (state IN ('OPEN','ESCALATED','SUPERSEDED') OR verdict_at IS NOT NULL)
);
CREATE INDEX ON approval_request (state, escalate_at);   -- ladder timer scan
CREATE INDEX ON approval_request (incident_id);
```

Two constraints carry the load-bearing crosswalk (keystone §2) at the one table this layer newly owns:
- `tier_requires_loop_c` forbids the crosswalk-illegal `(loop='B', tier IN (3,4))` rows. Loop B is
  test-files-only and tops out at Tier 2 (`LOOP-B-SPEC.md`); only Loop C reaches Tier 3/4
  (`LOOP-C-DEFERRED.md`, `ORCHESTRATION.md` §crosswalk). Note Loop C is deferred, so Tier-3/4 rows are
  not *produced* in v1 — the constraint documents and enforces the invariant so the schema cannot admit
  the illegal shape when Loop C is later earned.
- `tier4_is_plan_no_diff` encodes that a Tier-4 row is a plan-approval with no authored diff, so
  `fix_sha`/`parent_sha` are null — the agent proposes a plan, it does not author code (keystone §3.1).

### 3.2 Per-tier timeout + escalation — config and transitions

The ladder is a durable timer (`escalate_at`) scanned by the orchestrator, not an in-memory `setTimeout`
— it survives restarts and is replayable. Each fire is one deterministic transition, audited.

```yaml
# hitl-ladder.yaml — owned by HITL-APPROVAL.md
ladder:
  tier2:
    # Tier 2 that reaches this queue is a PROPOSE (L1) PR or an off-hours downgrade — not urgent-fatal.
    primary_timeout_min: 120
    on_timeout: escalate_to_secondary       # then reminder cadence; never auto-approves, never auto-rejects
    secondary_timeout_min: 240
    on_secondary_timeout: remind             # stays OPEN; a stale PR is harmless, unlike a stale write
  tier3:
    primary_timeout_min: 20                  # STRESS-TEST §6: gated tiers must not go dark — see §3.3
    on_timeout: escalate_to_secondary
    secondary_timeout_min: 20
    on_secondary_timeout: page_oncall_bridge # exhausted the named humans → page the on-call bridge, stay OPEN
  tier4:
    primary_timeout_min: 15
    on_timeout: auto_reject                  # a Tier-4 action must NEVER pass by default (§3.3)
    notify_on_reject: true
```

State transitions (deterministic; each is an audit event, `SECURITY-THREATMODEL.md` §7.2):

```
OPEN ──approve(verdict_by)──▶ APPROVED        → orchestrator RESUME → apply-time writer (ORCHESTRATION §5)
OPEN ──reject(verdict_by)───▶ REJECTED        → orchestrator RESUME → no write; feeds override telemetry (§5)
OPEN ──edit(verdict_by,…)───▶ APPROVED        → resume with the edited diff (§4.3 edit contract)
OPEN ──timer(tier3)─────────▶ ESCALATED       → current_approver := secondary; re-render to secondary (§3.3)
OPEN ──timer(tier4)─────────▶ REJECTED        → AUTO-REJECT + notify (§3.3); orchestrator records + closes
ESCALATED ──timer(tier3)────▶ (page bridge)   → stays ESCALATED, on-call bridge paged; NEVER auto-approves
* ──incident terminal (ORCHESTRATION §3 CAS: resolved/rolled-back)──▶ SUPERSEDED → cancel request, edit msg
* ──kill engaged (keystone §5)──▶ request stays OPEN but RESUME into any write is blocked at the guard
```

`state='SUPERSEDED'` is **request cancellation** — the *approval request* is withdrawn because the
incident reached a terminal state (e.g. a human out-raced the RCA per `ORCHESTRATION.md` §3's
`notify_state` CAS, or the incident was manually resolved). It is **not** the `superseded_by_human`
*outcome label*: that label is a Loop A trace outcome, authored by `LOOP-A-SPEC.md` §8 / persisted by
`INCIDENT-MEMORY.md` §5, and it carries no trust weight (keystone §3.6). This layer never writes the
`superseded_by_human` resolution label; it only cancels its own queue row.

### 3.3 Tier 3 and Tier 4 — the two rules that fix the dark-hours failure

**Tier 3: no answer in N min → secondary approver (never auto-anything).** A Tier-3 action carries
moderate risk and *must* have a live human. The ladder is what keeps the gated tier from going dark
(attack #6): on `primary_timeout_min` (default 20) with no verdict, the request escalates to the team's
`secondary_on_call`, re-rendering the full payload to the secondary; on a second timeout it pages the
on-call bridge. It **never** auto-approves and **never** auto-rejects — it keeps finding a human. Combined
with §2.3 (off-hours auto-apply downgrades to a waiting PR), the night-time picture is now: gated tiers
escalate to reach a human, and the previously-ungated auto-apply path is *also* gated. Both halves of the
inversion are corrected.

**Tier 4: no answer → auto-REJECT with notification.** A Tier-4 action (migrations, auth, billing, infra,
secrets — `risk_policy.yaml protected_paths`, keystone §3.4) must **never pass by default.** It is
synchronous plan-approval only; the agent proposes a plan, it does not author code (keystone §3.1) — which
is why a Tier-4 `approval_request` row has null `fix_sha`/`parent_sha` (§3.1). On
`tier4.primary_timeout_min` (default 15) with no verdict, the request is **auto-REJECTED**, the incident
is left for a human with an explicit notification, and the rejection is audited. This is the deliberate
asymmetry with Tier 3: for Tier 3 silence must *find a human*; for Tier 4 silence must *deny*. The
default state of the most dangerous class is "no."

### 3.4 Reminder & re-render cadence

While OPEN/ESCALATED, the bot re-pings on a backoff (default 5, 15, 30 min, then hourly) by *editing the
existing Telegram message* (never spamming new messages — the `telegram_msg_ref` is stable), updating the
"waiting Nm · escalates in Mm" line. This is bounded by the fatigue guards in §5.

---

## 4. The Telegram bot

The bot is the single HITL surface all loops deliver into (`ARCHITECTURE-ORIGINAL.md` §8). It renders the
**compressed why-trace** (`LOOP-A-SPEC.md` §7 — *not* raw logs; raw logs are one deep-link away), sized to
read on a phone at 3am, and it actuates verdicts back onto `approval_request`.

### 4.1 Message format

For a Loop A diagnosis hand-off, the message is exactly the `LOOP-A-SPEC.md` §7 payload (rendered by that
spec's contract, delivered via the `ORCHESTRATION.md` §3 `notify_state` CAS). For a Loop B/C **approval**
it is the payload below — the same compressed-trace discipline, plus the diff summary and the ladder state:

```
🟠 checkout-api — stale test heal  ·  Tier 2 · L1 PROPOSE
class: src/checkout · assertion_heal          waiting 0m · (off-hours: PR, will wait for you)

WHY (from why-trace rca-uuid · confidence: CONFIRMED ✅)
Deploy dpl_88213 changed tax-rate lookup; test tax.spec.ts asserts the old
shape. Author confirmed intent at PR time; heal updates the assertion only.

GROUNDED CHECKS
  ✅ test failed on parent, passes on fix (must-fail anchor)
  ✅ no-weakening (new assertion not a superset of old)
  ✅ mutation score on touched module ≥ effective bar
  ✅ every claim cited · ✅ alternatives closed (structural)

SIMILAR PAST
  ✅ Mar 2026 — same lookup-shape heal → matured, no recurrence   [confirmed_good]
  ⚠️ anti-pattern: none

⚠️ SUSPICIOUS CONTENT IN LOGS — none detected

BLAST RADIUS
  test file only · no prod path · reversible: revert-clean (side-effect-free module)

DIFF  (+3 −3)   [ Open full diff + why-trace ]

[ ✅ Approve ]   [ ✏️ Edit ]   [ ❌ Reject ]
```

Required fields, each traced to a source:
- **Compressed why-trace, not raw logs** (`LOOP-A-SPEC.md` §7). The WHY block is the ranked hypothesis in
  prose; the deep-link opens the full immutable trace + diff in the web UI.
- **Confidence booleans, never a number** (`LOOP-A-SPEC.md` §4/§7, defends attack #2). The human sees
  which grounded checks passed — a thin RCA is *visibly* thin (fewer green checks), not hidden behind a
  "0.87." The "every claim cited / alternatives closed" line is labeled *(structural)* so it is not read
  as a semantic guarantee (`LOOP-A-SPEC.md` §4, D8).
- **Similar-incident outcomes** — positives (`confirmed_good`) and labeled anti-patterns
  (`recurred`/`reverted`), per `LOOP-A-SPEC.md` §6 outcome-weighted retrieval. A `provisional_human_confirmed`
  neighbor is rendered with an explicit "provisional, unverified" tag so a tired tap cannot masquerade as
  a trusted exemplar (keystone §3.6).
- **Blast radius** — from the `GateResult` (`VERIFICATION-GATE.md`): module area, prod-path touch,
  reversibility attestation.
- **`suspicious_content_flag` surfaced on the phone message**, not only in the deep-linked trace
  (`LOOP-A-SPEC.md` §7, D7). When true the line reads
  `⚠️ SUSPICIOUS CONTENT IN LOGS — treat this cause with caution; a log line contained instruction-like
  text (quoted in the trace)`. The decision surface must carry the D7 warning because it is the one place
  the human actually decides at 3am.
- **Inline buttons** `Approve` / `Edit` / `Reject`, plus a deep-link to the full diff + why-trace web UI.
- **Off-hours banner.** When §2.3 downgraded the action, the header shows
  `(off-hours: PR, will wait for you)` so the reviewer knows this is a parked proposal, not a live
  auto-apply awaiting a rubber stamp.

### 4.2 The button → verdict contract (anti-rubber-stamp)

This is the load-bearing contract with `LOOP-A-SPEC.md` §7. **A button tap emits a PROVISIONAL human
verdict event; it never writes a durable *positive* outcome label. Promotion to `confirmed_good` still
requires the watcher window; the tap never grants it.** Ownership is split cleanly: this layer *emits* the
verdict event; `INCIDENT-MEMORY.md` §5 *persists* the label onto `resolutions` (which it owns, with a
freeze trigger); `ORCHESTRATION.md` §5 *inserts* any `auto_action` row.

| Button | Loop A hand-off (diagnosis) | Loop B/C approval |
|---|---|---|
| **Approve** / **Mark cause confirmed** | emits a `provisional_human_confirmed` verdict event → `INCIDENT-MEMORY.md` persists `resolutions.outcome_label = 'provisional_human_confirmed'` (keystone §3.6); feeds the RCA-accuracy metric (§9 metrics); **does NOT** set `confirmed_good` | sets `approval_request.state = APPROVED`; orchestrator RESUMEs into the apply-time writer, which inserts the `auto_action` row (`ORCHESTRATION.md` §5). The outcome verdict stays `pending` until the watcher matures it. |
| **Reject** / **Wrong RCA** | emits a `wrong_rca` verdict event (an anti-pattern label, `LOOP-A-SPEC.md` §6, persisted by `INCIDENT-MEMORY.md`) | sets `state = REJECTED`; no write; feeds override telemetry (§5) and the Trust Controller's `N_reject` *contraction* breaker (`TRUST-CONTROLLER.md` §4.2) — **contract only, never expand** |
| **Edit** | n/a (Loop A never authors a change) | see §4.3 |

The pivotal invariant, restated because it is exactly the D6 hole: **the tap is close to the ambiguous
"human override rate" signal the Trust Controller rejects** (`TRUST-CONTROLLER.md` §4.3) — "good fix" and
"nobody really checked" produce the byte-identical tap. So the tap:
1. originates at most a `provisional_human_confirmed` verdict (a **weak**, controller-neutral retrieval
   context only, keystone §3.6) — this layer emits it, Incident Memory stores it;
2. on a Loop B/C approve, triggers the apply-time writer (`ORCHESTRATION.md` §5) to insert the
   `auto_action` row for the *merge event* so the class's L1→L2 ladder has a data point (keystone §3.2,
   §4). That row is **immutable**; there is no `pending`/`state` column on it. The *outcome verdict* for
   its `actionId` is `pending` (weight 0 via `TrustController.outcomeWeight`, `TRUST-CONTROLLER.md`) until
   the watcher matures it;
3. and never, by itself, moves the class's autonomy level (that is outcome-driven).

Promotion to `confirmed_good` — the only positive retrieval exemplar and the only thing that advances
trust — comes from the outcome watcher surviving `W_mature = 30d` with no recurrence/spawn/revert
(keystone §3.5, `INCIDENT-MEMORY.md` §5.3). The button is a verdict on *the trace*, not on *the world*.

### 4.3 The Edit contract

`Edit` opens the deep-linked web UI (the phone is not where a diff is edited). The human's edited diff
becomes the change of record; on save the request transitions `APPROVED` with the edited `fix_sha`, and
the orchestrator resumes into the apply-time writer, which records `applied_by = 'human_approved'`
(`ORCHESTRATION.md` §5).

**The editing human is written to the *descriptive* `approval_request.verdict_by` (and, on merge, to
`resolutions.merged_by`) only — NOT to `accountable_owner`.** Per keystone §3.3 / D9 and `ORCHESTRATION.md`
§5.4, the accountability owner of record is always `trust_class.owner`, materialized frozen into
`auto_action.accountable_owner` by the apply-time writer; approver/editor identity is descriptive and is
never the owner of record. Editing a diff does not transfer class ownership to the editor.

An edited change re-enters the Verification Gate before landing (an edit is a new diff; it must clear the
same non-LLM battery, keystone §3.4) — the human cannot edit *past* the mutation / must-fail / path-guard
gates, only within them.

### 4.4 Identity binding

Every verdict is attributed to the authenticated Telegram identity → the human-role registry
(`accountability.yaml`, `SECURITY-THREATMODEL.md` §6), written to the descriptive `verdict_by` and to the
immutable audit log before the resume. A tap from an identity not in the request's approver chain
(`primary_approver` / `current_approver` / the on-call role) is refused and audited — you cannot approve a
request that was never routed to you. This binding is descriptive attribution only; it never sets
`accountable_owner` (§4.3).

---

## 5. Approval fatigue (principle-1, reborn at PR level)

The original principle-1 warning — "don't drown the human in alerts" — reappears here as a **rubber-stamp**
risk: a reviewer facing a wall of look-alike approvals stops reading and taps Approve, which is precisely
the "nobody is checking" failure the Trust Controller's outcome-gating is built to survive
(`TRUST-CONTROLLER.md` §4.3). This layer's job is to keep the human's attention *scarce and real* so the
tap means something, and to feed the resulting signal to policy **without ever letting it expand
autonomy** (D6).

### 5.1 Batching & rate guards

```yaml
# hitl-fatigue.yaml — owned by HITL-APPROVAL.md
fatigue:
  # Batch look-alikes: multiple OPEN requests with the same class_key within a window collapse into
  # ONE digest message with a per-item Approve/Reject, so the reviewer sees the pattern, not 12 pings.
  batch_window_min: 10
  batch_by: [class_key, team]
  max_batch_items: 20
  # Hard rate ceiling on distinct approval pings per reviewer per hour; excess are folded into the next
  # digest rather than sent as separate messages. Bounds attention load.
  max_pings_per_reviewer_per_hour: 6
  # Anti-rubber-stamp friction: if a reviewer approves N requests in under T seconds each (too fast to
  # have read), the NEXT approval in that class requires the deep-link to be opened before the button
  # arms (a "you haven't looked" interstitial). Friction, not a block.
  fast_approve_streak: { count: 5, per_item_seconds: 8 }
  require_deeplink_open_after_streak: true
```

Batching also composes with the churn escalator (`TRUST-CONTROLLER.md` §4.1): when an area trips its churn
hold, its forced-to-L1 actions arrive as approvals here; batching by `class_key`/`team` surfaces the
*churn pattern* as one digest with the `churn_alert`, so the reviewer sees "this area is thrashing" rather
than a drip of individually-plausible diffs — which is the diff-stacking signature the churn escalator
exists to catch. (The churn escalator is a net-new guard owned by `TRUST-CONTROLLER.md` §4.1; this layer
only *surfaces* its holds, it does not compute them.)

### 5.2 Override-rate telemetry — feeds policy, never expands autonomy (D6)

Every verdict updates per-class override telemetry:

```ts
// override telemetry — a REPORTING surface for policy review + the Trust Controller's contraction path.
interface OverrideStat {
  classKey: string;
  window: '24h' | '7d' | '30d';
  proposed: number;          // approvals of L1/PROPOSE actions
  rejected: number;          // Reject / Wrong-RCA taps
  edited: number;            // Edit verdicts (a soft "not quite right")
  auto_rejected_tier4: number;
  reject_rate: number;       // rejected / (proposed + rejected)
}
```

Two consumers, one direction each:
- **Policy review (human).** A systematically high `reject_rate` for a class is *not* "the reviewer is
  fussy" — it is a signal to **narrow** that class's policy (`ARCHITECTURE-ORIGINAL.md` §8). Surfaced on
  the operator dashboard next to the class's `harm_rate` / `l1_merged_harm_rate` (`TRUST-CONTROLLER.md`
  §6).
- **Trust Controller (automatic, contraction only).** A reject burst feeds the `N_reject` breaker
  (`TRUST-CONTROLLER.md` §4.2, default 5 in 24h → trip the class to L1). This is the *only* automatic use
  of override data, and it can only **contract**.

The standing invariant, mirrored from `TRUST-CONTROLLER.md` §4.3 so it survives edits to this spec:

> **A low override / low-rejection rate is NEVER, on its own, a reason to expand a class's autonomy.**
> Low rejection is ambiguous ("good" vs "nobody checked"); it is admissible only as a *contraction*
> trigger. Expansion is outcome-gated in the Trust Controller alone. This layer emits the number; it does
> not act on a *low* value.

---

## 6. Kill-switch release — signed on-call action over the authenticated channel

The kill bit lives in `ORCHESTRATION.md` (keystone §5), is heartbeat-fail-safe (absence of a healthy
heartbeat = KILL, `SECURITY-THREATMODEL.md` §7.1), and freezes all autonomy to diagnosis-only. **Only a
signed action from the on-call role, over this authenticated HITL channel, can RELEASE the freeze. No
agent tool can toggle the bit** (`SECURITY-THREATMODEL.md` §7.1 "not agent-reachable").

Release is the sensitive direction and is the only kill-switch operation this layer actuates (engage can
also come from monitoring / any on-call; release is few-writer and dual-attributed).

### 6.1 The auth

```ts
// hitl/kill-release.ts — the ONLY path that can clear the freeze. Not exposed as an agent tool.
// The Telegram bot surfaces the command; the ORCHESTRATOR verifies and applies. This layer proves intent.
interface KillReleaseRequest {
  action: 'release';
  by: string;                 // Telegram identity → on-call role (accountability.yaml, SECURITY §6)
  mfa_assertion: string;      // MFA-backed, per SECURITY §7.1 ("MFA-backed"); verified server-side
  reason: string;             // free text, audited
  signature: string;          // detached signature over (action ∥ by ∥ nonce ∥ killed_at)
  nonce: string;              // single-use; replay-rejected against a used-nonce table
}

async function requestKillRelease(req: KillReleaseRequest): Promise<ReleaseResult> {
  // 1. AUTHN: the Telegram identity is bound to a real on-call member (§4.4). Reject otherwise.
  assertOnCallRole(req.by);                                   // must be in the small on-call writer set
  // 2. MFA: verify the assertion out-of-band (SECURITY §7.1). No MFA → refuse, audit.
  assertMfa(req.by, req.mfa_assertion);
  // 3. SIGNATURE: verify the detached signature with the on-call member's registered public key.
  //    The signed message binds the current killed_at, so a signature cannot be replayed across freezes.
  assertSignature(req.signature, canonical(req.action, req.by, req.nonce, currentKilledAt()), req.by);
  // 4. NONCE: single-use; reject replays.
  assertUnusedNonce(req.nonce);
  // 5. DUAL ATTRIBUTION: releasing requires the signed action AND is logged with the releaser + the
  //    engage record it clears (SECURITY §7.1 "logged with dual attribution").
  audit('kill_switch_release', { by: req.by, reason: req.reason, clears: currentKillRecord() });
  // 6. APPLY: hand to the orchestrator, which is the ONLY writer of the bit (keystone §5). This layer
  //    never writes the bit directly — it proves intent; ORCHESTRATION.md flips it and TrustController
  //    RESUMEs to min(earned_level, predicate) per its §5, honoring any freeze-time demotions.
  return orchestrator.releaseKill({ by: req.by, nonce: req.nonce, reason: req.reason });
}
```

### 6.2 What this guarantees

- **No agent can self-release.** The release path is out-of-band from the pipeline the agent runs in
  (`SECURITY-THREATMODEL.md` §7.1); it is not a registered agent tool, and it requires a signature the
  agent's identity cannot produce. A fully-steered agent (`SECURITY-THREATMODEL.md` §5.4) cannot re-enable
  itself.
- **The bit's writer is the orchestrator, not this layer.** This layer authenticates intent and hands a
  verified release to `ORCHESTRATION.md`, which is the single authoritative writer (keystone §5). The
  three enforcement points (orchestrator freeze, Trust Controller effective-L0, Verification Gate
  `frozen`) all *derive* from that one bit; releasing it lets the Trust Controller restore
  `min(earned_level, predicate_now)` — never `pre_kill_level` — so a demotion that matured during the
  freeze is honored (`TRUST-CONTROLLER.md` §5).
- **Fail-safe is preserved.** If the HITL channel or the switch service is unreachable, the heartbeat is
  absent and the system stays frozen (degraded to Loop A copilot, `SECURITY-THREATMODEL.md` §7.1). A
  DoS of this channel can only *keep* autonomy frozen, never enable it.
- **While frozen, approvals still queue but cannot resume into a write.** An `approval_request` may sit
  OPEN during a freeze; the orchestrator's kill-check at the tier-transition guard blocks the RESUME into
  any apply/merge (keystone §5). Loop A hand-offs continue (diagnosis-only is always safe). This is why a
  verdict that lands mid-freeze cannot slip a write through the gap.

---

## What this closes

- **Attack #6 (perverse off-hours schedule) — CLOSED here, end-to-end, in v1 with no earn path.** The
  business-hours model (§2.2) gates **any** auto-apply on staffed hours (§2.3), so the previously-ungated
  24/7 auto-apply path now downgrades to a propose-and-wait PR *unconditionally* off-hours; the gated
  tiers no longer go dark because the Tier-3 ladder escalates to a secondary then pages a bridge (§3.3)
  and Tier-4 auto-rejects on timeout rather than passing by default. Autonomy now tracks trust across the
  clock. "Earned off-hours autonomy" is a **deferred** extension with an explicitly-named unmet
  dependency on `TRUST-CONTROLLER.md` (§2.4): an off-hours dimension on `OutcomeEvent`, a fourth
  controller read, and off-hours config — none of which exist today. It is never granted by a tap.
- **The business-hours gate** is owned here as the keystone §3.1/§7 correction, mirrored into
  `risk_policy.yaml auto_apply_requires: business_hours` (keystone §3.4) which routes to this layer.
- **The `provisional_human_confirmed` contract** (§4.2) — the button *emits* a provisional verdict event
  that `INCIDENT-MEMORY.md` persists; it feeds the RCA-accuracy metric and (on Loop B/C approve) triggers
  the apply-time writer's L1 `auto_action` row, but it never sets `confirmed_good` and never expands
  autonomy; the watcher window (keystone §3.5) is the only path to a positive exemplar and to trust. The
  anti-rubber-stamp argument of `LOOP-A-SPEC.md` §7 is honored at the PR level too (§5).
- **Ownership boundaries are clean** (§0): this layer writes no `auto_action` row, materializes no
  `accountable_owner` (that is `trust_class.owner`, frozen by `ORCHESTRATION.md` §5.4 — the editor is only
  the descriptive `verdict_by`/`merged_by`, §4.3), persists no `resolutions` label directly, and toggles
  no kill bit. It emits events and enqueues requests; other specs own the durable state.
- **Async-default posture** (§1): durable queue + ladder + interrupt/resume, decoupling the human's
  verdict from any live socket, agent step, or short-lived token — the correctness fix
  `ARCHITECTURE-ORIGINAL.md` §8 demanded.
- **Kill-switch release auth** (§6): only a signed, MFA-backed, dual-attributed on-call action over this
  authenticated channel releases the freeze; no agent tool can; the orchestrator remains the single
  writer of the bit; fail-safe (heartbeat-absence = frozen) is preserved.

Everything here is replayable from `approval_request` + the immutable hash-chained audit log
(`SECURITY-THREATMODEL.md` §7.2); the kill switch is honored at every resume-into-write; and no verdict,
no override number, and no tap can raise a class's autonomy — that authority belongs to
`TRUST-CONTROLLER.md` alone, on outcomes.
