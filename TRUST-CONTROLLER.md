# Trust Controller — autonomy expansion (spec)

> **Reconciliation note.** `ARCHITECTURE-REFRAMED.md` is the source of truth for cross-component
> contracts. This spec's positions (`W_mature`, asymmetric fast-demote/slow-promote) were adopted as
> canonical. Aligned here: the `OutcomeEvent` field is **`actionId`** (keystone §3.2); the
> `assisted_action` (`human_approved` L1) rows this ladder depends on are written by `ORCHESTRATION.md`'s
> apply-time writer for **both** landing variants (keystone §3.2), so `l1_merged_harm_rate` is computable;
> `module_area` is single-sourced by this spec and referenced elsewhere (keystone §6).
>
> **Round-2 obligations (from `ORCHESTRATION.md` / `HITL-APPROVAL.md` finalization):** this interface exposes
> **three** class-keyed reads to the router — `effectiveLevel`, `requiredMutationScore`, `accountabilityOwner`
> (keystone §2), not `effectiveLevel` alone. The `auto_action` DDL in this file is **superseded** by the
> canonical keystone §3.2 schema (`action_id` PK, `gate_result`, `accountable_owner`, `parent_sha`, `fix_sha`).
> **Off-hours autonomy is NOT in v1:** `hasEarnedOffHours`, an off-hours-tagged dimension on `OutcomeEvent`, and
> `K_off`/`D_min_off` config are a net-new **OPEN** item not implemented here (`HITL-APPROVAL.md` addendum #2);
> until built, off-hours downgrades every auto-apply to a PR.

Owns the single question the reframe (STRESS-TEST §3, D5, D6) refuses to answer with a
prompt: **what autonomy level is each incident-class allowed to run at, and who moved it
there?** The controller is the only component permitted to raise or lower a class's level.
No agent, no config push, no human approval-click grants autonomy — they all feed
evidence *into* this controller, which decides on measured outcomes alone.

Deterministic. No LLM. It is a **pure fold over an append-only outcome event stream** into
a state machine of per-class counters. That is deliberate: the thing that governs how much
the LLM system is trusted must not itself be an LLM judgment (D8 — independence from shared
blind spots), and its every decision must be replayable byte-for-byte from the event log —
see §7 for the exact determinism contract.

Scope note per the reframe: in v1 the only classes that can reach an auto-apply level are
**Loop B** jobs (flaky-quarantine is born autonomous; test-heal is human-gated author-assist —
see LOOP-B-SPEC.md). **Loop C** (production-code auto-repair) classes exist in the table but
start pinned at L1 and are earned per-class, later, on this controller's outcome data
(D5, D10). The controller is built now so that when a Loop C class is eligible, the promotion
path is already governed — never bolted on after the fact.

---

## 1. Purpose

Attack #3 (STRESS-TEST §3, trust runaway): expanding autonomy by **human-override-rate** is a
positive-feedback loop. Early auto-fixes are subtly wrong, the weak suite passes them
green, harm surfaces slowly and diffusely, nobody vetoes at approval time → override-rate
reads LOW → the system concludes it is trustworthy → expands into the classes it is
worst at. "Good fixes" and "nobody is checking" produce the *identical* low-override
metric. Override-rate is an input-side proxy; it measures the reviewer, not the world.

The Trust Controller replaces that with an **outcome-driven** control law (D6). Autonomy
for an incident-class rises only after the *world* confirms past actions in that class did
no harm — the incident did not recur, no new incident spawned in the touched area, no human
later reverted the change. It falls immediately on the first confirmed harm. Expansion is
slow and evidence-gated; contraction is instant and cheap. The asymmetry is the whole point.

It optimizes explicitly *against* one number (§6): **incidents caused or worsened by an
auto-applied fix.** Everything else is secondary.

Interfaces:

- **Reads** outcome events from Incident Memory (see INCIDENT-MEMORY.md).
- **Writes** the authoritative per-class autonomy level, consumed by the Risk Classifier
  / routing policy (ARCHITECTURE-ORIGINAL §5) and by Loop B's job dispatcher.
- **Publishes** each class's outcome verdict *back* to Incident Memory so retrieval can be
  outcome-weighted (§8 — closes attack #8, the poisoning path that compounds with #3).
- **Subscribes** to the kill switch (§5) and to the circuit-breaker action stream.
- **Emits** every transition to the immutable audit log (cross-cutting requirement).

What this component does **not** do: it is not a defense against log-borne prompt injection
or signal spoofing. It is deterministic and reads only resolved outcome events; a crafted
log line cannot steer it. Injection/spoof defense lives in the RCA agent and
VERIFICATION-GATE.md (D7). The controller's only contribution to that threat is bounding
**blast radius** via the global rate cap (§4.2) — a storm cannot fan out into a burst of
auto-actions. It is not listed as an owner of D7.

---

## 2. The outcome signal (D6)

### 2.1 What an "incident-class" is

The unit of autonomy is a **class**, not an individual incident. A class is a stable key
under which outcomes accumulate. Definition:

```
class_key = hash(loop, action_kind, module_area)
  loop        ∈ { B_flaky, B_heal, C_repair }
  action_kind ∈ { quarantine, assertion_heal, null_guard, off_by_one, config_patch, ... }
  module_area = repo-relative directory at a fixed depth (default depth 2, e.g. "src/checkout")
                — NOT the file, so a rename inside the area doesn't reset the class,
                  and NOT the whole repo, so one hot area can't be dragged up by a quiet one.
```

`module_area` at directory granularity is the deliberate answer to fingerprint drift
(STRESS-TEST §9): a per-file key would silently reset a class's earned trust on every
refactor. Area-level survives refactors while still isolating blast radius. **This choice is
load-bearing for harm attribution too** — every attribution rule in §2.2/§6.2 is keyed on
`module_area` (with git rename-follow), never on a raw file path, so a rename cannot let
harm escape the same way it must not let trust reset.

### 2.2 Events consumed from Incident Memory

Two kinds of action produce an outcome atom, because both an auto-apply AND a
human-approved-merge must be scoreable — see the outcome-atom note below (this is what makes
L1→L2 bootable at all):

- **`auto_action`** — written at apply-time for a machine-applied change (Loop B quarantine,
  or an eventual Loop C merge). `applied_by = 'machine'`.
- **`assisted_action`** — written when a human approves and merges a PROPOSE-level (L1) PR
  that the agent authored (Loop B heal, or a Loop C proposal). Same schema, `applied_by =
  'human_approved'`. It carries the same `class_key`, `touched_files`, and `why_trace_id`,
  and it accrues the **same outcome verdicts** (recurrence / spawn / revert / matured). It is
  *not* auto-applied, but it *is* the agent's diff in production, so its outcomes are exactly
  the evidence needed to decide whether the class is safe to auto-apply.

Both are stored in one `auto_action` table discriminated by `applied_by` (see the data
model). Below, "action" means either atom unless qualified. The controller does **not** score
an action at apply-time — it is `pending` until the outcome window closes. Incident Memory
emits these events, each carrying the action id and its `class_key`:

| Event | Emitted when | Meaning for the class |
|---|---|---|
| `applied` | an action lands (machine auto-apply, or human-approved L1 merge) | opens a pending outcome window |
| `recurrence` | a new incident lands with the **same fingerprint OR same `module_area` + same symptom signature** within `W_recur` days of an action | **caused-incident** (the fix didn't hold / masked the cause) |
| `spawn` | a *new* (different-fingerprint) incident is first-seen **within the `module_area` the action touched** (rename-followed, see below), within `W_spawn` days | **caused-incident** (the fix introduced a new fault) |
| `revert` | a human reverts or manually overwrites the applied change (detected via git: revert commit, or the touched lines rewritten by a human within `W_revert` days) | **caused-incident** (human judged it wrong post-hoc) |
| `matured` | the full maturation delay (§6.2) elapses after `applied` with none of the above | **confirmed-good** |

Recurrence match is symptom-signature-based, not just fingerprint-based, precisely because
fingerprint drift would otherwise let a recurrence hide as a "new" incident.

`spawn` attribution rule (this is the harm-attribution definition, §6): an incident is
attributed to a prior action iff **(a)** it first-appears **inside the `module_area` that
action's diff touched — tracking file identity through git rename detection (`git log
--follow` on the touched files) so a post-action move within the area still matches** — **and
(b)** it appears within `W_spawn` days, **and (c)** no *human* commit touched the
overlapping lines between the action and the new incident. Condition (a) is deliberately
area-scoped (not file-path-scoped): a per-path spawn rule would be defeated by the exact
STRESS-TEST §9 rename drift the class key is designed to survive — harm must be attributable
on the same granularity trust is earned on, or a refactor becomes a laundering step for
machine-caused faults. Condition (c) stops the controller blaming the machine for a human's
later change on top of its work. Ambiguous cases (a human *and* the agent both touched the
overlapping lines in-window) are recorded as `spawn_contested` — counted as caused for
contraction (safety-conservative) but flagged for human adjudication before they permanently
sink a class in the long-run stats.

### 2.3 Confirmed-good rate

Per class, over a sliding window of the last `M` **decided** outcomes (matured-or-caused;
default `M=50`; if fewer than `M` exist, over all of them):

```
caused         = count(recurrence) + count(spawn) + count(revert)      # distinct action ids
confirmed_good = count(matured)
decided        = caused + confirmed_good        # pending actions are NOT counted either way
confirmed_good_rate = confirmed_good / decided  (decided > 0; undefined ⇒ treated as ineligible)
```

Pending actions never count — an action mid-window is neither evidence for nor against.
This is what makes "nobody is checking" *unable* to inflate the rate: silence produces
`pending`, and pending contributes to no numerator or denominator. Trust only moves on
outcomes the world actually resolved.

Note this rate alone cannot be the *only* promotion gate: whenever there are zero caused
incidents in the window, `confirmed_good_rate` is exactly `1.0` by construction. That is why
the promotion predicate (§3.2) splits the two roles — a **recent** strict-zero-caused window
and a **long-run** rate floor — so the rate threshold is not a tautology of the zero-caused
condition. See §3.2 condition 2 vs 3.

---

## 3. The control law

### 3.1 Autonomy levels (per class)

```
L0  DIAGNOSE_ONLY      RCA copilot only. Zero write. (Loop A is pinned here forever.)
L1  PROPOSE            Agent opens a PR / author-assist prompt. Human merges. (Loop B heal lives here.)
L2  AUTO_CONTAINED     Auto-apply, zero-behavior blast radius. (Loop B flaky-quarantine.)
L3  AUTO_REVERSIBLE    Auto-apply reversible production fix, business-hours, proven side-effect-free. (Loop C, earned.)
```

L3 is the only genuinely dangerous level and is reachable *only* for a `C_repair` class,
*only* under the additional hard gates below. Loop B classes cap at L2 (quarantine) / L1
(heal) by construction — the LOOP-B-SPEC blast-radius argument, not this controller,
sets those ceilings. The controller moves a class *within* its permitted band.

### 3.2 Promotion predicate (all must hold — AND, not OR)

A class at level `Ln` may advance to `Ln+1` only when **every** condition is true:

```
1. confirmed_good        ≥ K                        # K absolute confirmed-good outcomes at Ln
2. confirmed_good_rate    ≥ θ  over the M-window     # LONG-RUN floor: tolerated historical harm
3. caused_in_recent(D_min) == 0                      # ZERO caused in the last D_min days — recent, strict
4. window_span            ≥ D_min days               # calendar dwell: harm must have had TIME to surface
5. no open circuit-breaker trip for this class       # §4
6. no active same-area churn hold on the class's area # §4.1
7. kill switch not engaged                           # §5
8. (L2→L3 only) the target class satisfies the L3 hard-gates in §3.5
```

Conditions 2 and 3 are **distinct measurements over distinct windows** — this is the fix for
the otherwise-inert rate gate:

- **Condition 3** is a *recency* gate on a short trailing window (`D_min` days): zero
  caused-incidents *lately*. It answers "is the class currently safe to widen?" One recent
  caused-incident is direct evidence it is not, so this is strict zero, not a floor.
- **Condition 2** is a *long-run* gate on the `M`-outcome window, which may contain older,
  now-aged caused-incidents that are outside the `D_min` recency window. It answers "does this
  class have a clean *track record*, or has it caused harm repeatedly over its history even if
  not in the last `D_min` days?" With `θ = 0.98` at L1→L2, a class that has quietly caused
  harm several times across its lifetime — each demoting it and then re-earning back to the
  L1→L2 boundary — will fail condition 2 even in a clean recent window, and cannot ratchet up.

Because condition 3 windows on *recent* days while condition 2 windows on the *last M
decided outcomes*, the two do not collapse into each other, and `θ` does real work: it caps
the class's lifetime caused-incident share independently of the recent clean streak.

Condition 4 defends the "harm surfaces slowly" failure mode: you cannot accumulate K
confirmed-good in a day and jump a level; real damage is diffuse and lagging, so promotion
requires that calendar time to have elapsed. Condition 6 refuses to promote a class whose
*area* is currently unstable (§4.1), even if the class's own numbers qualify.

Default numbers (per band; tuned per deployment, stored in config not prompt):

| Transition | `K` | `θ` (M-window rate) | `D_min` (recency + dwell) | Notes |
|---|---|---|---|---|
| L1 → L2 | 30 | 0.98 | 14 d | earn autonomous quarantine only after 30 human-approved-then-matured L1 actions in the class |
| L2 → L3 | 100 | 0.99 | 45 d | Loop C only; plus §3.5 hard gates; deliberately steep |

`θ` is high on purpose: at L2→L3, `θ=0.99` over a 100-window means a class whose lifetime
caused-share exceeds ~1-in-100 can never reach L3 even with a clean recent window, while
condition 3 additionally forbids *any* caused-incident in the last 45 days.

### 3.3 Demotion (asymmetric — fast)

Expansion took K outcomes and D_min days. Contraction takes **one** event:

```
On any single caused-incident (recurrence | spawn | revert | spawn_contested)
attributed to a class currently at Ln (n ≥ 2):
    → immediately drop the class to L1 (PROPOSE) — NOT one step, straight to human-gated.
      This mutates BOTH `level` (effective) AND `earned_level` (evidence), so a concurrent
      or subsequent kill/resume cannot restore the pre-demotion level (§5).
    → freeze re-promotion for a cooldown of C_cool days (default 30).
    → the outcome window is NOT reset, so the caused-incident keeps weighing against
      confirmed_good_rate (condition 2) during and after cooldown.
```

Drop to L1, not L2, because a caused-incident from an auto-apply class means the *auto-apply
mechanism itself* misjudged this class — the safe fallback is "human looks at every one"
until it re-earns trust. A class demoted to L1 must climb L1→L2 again through the full
promotion predicate, so the same caused-incident now sits in its M-window and drags
condition 2 down until it ages out — you cannot immediately re-promote past your own harm.

`spawn_contested` demotes too (safety-conservative), but if human adjudication later clears
it, the event is reclassified `matured` and the class may re-promote once cooldown expires.

### 3.4 State machine

```
                    promote-predicate (§3.2) met
        ┌───────────────────────────────────────────────┐
        │                                                │
        ▼                                                │
     ┌──────┐  promote   ┌──────┐  promote   ┌──────┐    │  promote (+§3.5)  ┌──────┐
     │  L0  │──────────▶ │  L1  │──────────▶ │  L2  │──┴──────────────────▶ │  L3  │
     │ diag │            │ prop │            │ auto │                        │ auto │
     └──────┘            └──────┘            │ cont │                        │ rev  │
        ▲                   ▲                └──────┘                        └──────┘
        │                   │                    │                              │
        │                   │  caused-incident   │  caused-incident             │
        │                   └────────────────────┴──────────────────────────────┘
        │                        (demote straight to L1, cooldown C_cool)
        │
        │  kill switch → all classes forced to effective L0 (§5), earned level preserved
        └──────────────────────────────────────────────────────────────────────────
```

L0→L1 is a human decision (an operator enables a class for PROPOSE), recorded like any
transition. L1→L2 and L2→L3 are the *only* transitions this controller makes autonomously,
and only upward through the predicate. Every downward edge is a caused-incident or the kill
switch. There is no autonomous edge that skips a level upward.

### 3.5 L3 hard gates (Loop C prerequisites, independent of the counters)

A `C_repair` class may occupy L3 only while ALL of these hold at *action time* — they are
checked by the Verification Gate (see VERIFICATION-GATE.md), the controller only records that
the band is permitted:

- sandbox repro is mandatory and reproduced the signal (D2), and the fix flipped it green (D3);
- mutation score on the touched module ≥ policy floor, and the regression test failed on the
  parent commit / passes on the fix commit (D4);
- diff within the class's size policy; not in `protected_paths`; proven side-effect-free
  (no migration, no external write) — else auto-escalate a level (ARCHITECTURE-ORIGINAL §5);
- business-hours window + fast-rollback ready + traffic-percentage cap (answers STRESS-TEST §6);
- a named accountability owner is on record for the class (D9) — no L3 without an owner.

If any gate fails for a specific action, that action is escalated for that incident; it does
not demote the class. Repeated gate failures feed the circuit breaker (§4).

Note that D9's owner requirement is **not** only an L3 gate — §3.6 extends it to L2.

### 3.6 Accountability owner required at L2 and above (D9)

D9 requires a named owner "for an auto-merged outage." Any level that **auto-applies** can
produce one — including L2 flaky-quarantine, which mutes a test (LOOP-B-SPEC: worst case a
real intermittent regression gets masked and later becomes an outage). Therefore:

> A class may not occupy **L2 or L3** with a null `owner`. Promotion L1→L2 has, as an
> implicit precondition, a non-null `owner` on the class row; a class whose owner is cleared
> is demoted to L1 at the next `reconcile()`.

L0/L1 do not require an owner (nothing is auto-applied; a human is the merge gate). The
schema constraint enforces this (see data model).

---

## 4. Runaway guards

Three independent guards, each catching a different runaway shape. They act *before* and
*orthogonally to* the control law — a class can be at L2 by the numbers and still be blocked
by a guard.

### 4.1 Same-area churn escalation (net-new guard, not a stress-test finding)

This guard is **not** in STRESS-TEST.md — it is a net-new defense this spec adds, closely
related to the §16 circuit-breaker guardrail in ARCHITECTURE-ORIGINAL and to the
"smaller but real" cluster in STRESS-TEST §9. The failure mode it addresses (call it
*diff-stacking*): the system makes change after change to one hot area, each individually
passing, the stack compounding into a mess no single diff review would catch, and each new
incident in that churning area feeding the next auto-action.

```
Maintain a rolling counter of ACTIONS per module_area over the last H hours (default H=6),
derived deterministically from the auto_action table windowed by applied_at (§7).
If actions_in_area(area, H) ≥ CHURN_MAX (default 3):
    → force-escalate: every further action in that area this window is forced to L1 (PROPOSE),
      REGARDLESS of the class's earned level. A human must look because the area is unstable.
    → set a churn hold on the area (blocks promotion via §3.2 condition 6).
    → raise a `churn_alert` on the area (Telegram HITL bot).
    → the hold clears only when the area goes CHURN_QUIET hours (default 12) with
      zero new actions — i.e. the area has to *settle*, not just tick the clock.
```

Keyed on `module_area`, not class, on purpose: diff-stacking is a *place* problem, not an
action-kind problem. Three different action-kinds each editing `src/checkout` in 6 hours is
exactly the compounding-mess signature and must escalate even though no single class tripped.

### 4.2 Circuit breaker

A global and per-class rate + failure breaker, independent of the outcome window (which is
slow by design; the breaker is the fast reflex):

```
Global:
  - max_auto_actions_per_hour (default 20). Exceed ⇒ pause ALL auto-apply, alert, require
    human un-pause. Bounds the blast radius of a signal storm / spoof (D7 is owned elsewhere;
    this only caps fan-out, it does not detect the spoof).

Per class (trips just that class to L1 + cooldown, does not touch others):
  - N_fail consecutive Verification-Gate / sandbox failures (default 3) ⇒ trip.
    Repeated inability to produce a green grounded fix = the class is misjudged now.
  - N_reject human rejects of PROPOSE-level output in a short window (default 5 in 24h) ⇒ trip
    the class down and freeze re-promotion. NOTE: this uses rejects only to *contract*, never
    to expand (see §4.3) — a burst of rejects is unambiguous ("humans keep saying no"),
    whereas the absence of rejects is ambiguous.
```

A trip is logged as a distinct event; a tripped class cannot promote (predicate condition 5)
until the trip is cleared by a human or by cooldown expiry with no further failures.

### 4.3 Why low override-rate ALONE must never expand autonomy

Stated as a standing invariant so no future change reintroduces attack #3:

> **A low human-override / low-rejection rate is NEVER, on its own, sufficient to raise a
> class's autonomy level.** It is admissible only as a *contraction* trigger (§4.2 `N_reject`).

Rationale, kept in the spec so it survives personnel changes: rejection is an *input-side*
signal — it tells you what the reviewer did, not what happened in production. Low rejection
has two indistinguishable causes: the fixes were genuinely good, or nobody was actually
reviewing (rubber-stamping, alert fatigue, off-hours). These produce byte-identical metrics.
Expansion is therefore gated exclusively on *outcome-side* evidence (§2/§3) — recurrence,
spawn, revert — which the reviewer cannot fake by clicking "approve." High rejection, by
contrast, is unambiguous and is allowed to *reduce* autonomy immediately. The asymmetry
(outcomes expand, rejects only contract) is the structural fix for the runaway.

---

## 5. Kill switch integration

One command (`selfheal kill` / the same cross-cutting kill switch) freezes the whole network
to diagnosis-only. The controller's participation:

```
On KILL:
  1. Snapshot each class's current earned_level into `pre_kill_level` (persisted). ADVISORY
     ONLY — see RESUME step 2 for why it is never used to raise trust.
  2. Force the EFFECTIVE level of every class to L0 (DIAGNOSE_ONLY). No auto-apply, no PROPOSE.
     Loop A (RCA copilot) keeps running — it is L0 already and writes nothing.
  3. Set a global `killed_at` timestamp. All action requests are refused with reason=killed.
  4. Pending outcome windows keep ticking in Incident Memory — kill freezes *action*, not
     *bookkeeping*. Outcomes that mature during a freeze are recorded normally, AND any
     outcome-driven demotion that fires during the freeze updates `earned_level` (§3.3),
     not merely the effective level.
```

The controller's earned state (earned levels, counters, cooldowns, breaker trips) lives in
Postgres and is **not** raised by KILL — only the effective-level override is set. Demotions
still write through to `earned_level` during the freeze. This is what lets RESUME be correct:

```
On RESUME (explicit human command, never automatic):
  1. Clear the global override.
  2. Restore each class to min( earned_level_now , level_the_predicate_still_justifies_now ).
     `earned_level_now` is read LIVE — NOT `pre_kill_level` — precisely so that a demotion
     which matured during the freeze is honored. `pre_kill_level` is advisory/audit only;
     using it here would re-raise a class the freeze-time evidence just lowered.
  3. Re-arm circuit breakers from their persisted state (a class tripped before KILL is still
     tripped after RESUME).
  4. Log KILL and RESUME as audit events with the full pre/post level map.
```

Resume is conservative by construction: it takes the *minimum* of the live earned level and
what current evidence would justify. KILL can never accidentally *raise* trust, and a freeze
during which harm surfaced comes back at the correctly-lowered level.

---

## 6. The harm metric (STRESS-TEST §9 gap)

The stress test's sharpest omission: ARCHITECTURE-ORIGINAL §13 is all "did it help" and has
no number for "did it hurt." The controller makes **harm** the primary optimized-against metric.

### 6.1 Definition

```
caused_incident := an incident (recurrence | spawn | revert | spawn_contested) attributed
                   to a prior action (auto OR human-approved) by the §2.2 attribution rules.

HARM RATE (primary safety metric, per class and global):
    harm_rate           = caused_incidents(machine)          / auto_actions_applied
    l1_merged_harm_rate  = caused_incidents(human_approved)  / assisted_actions_merged

The controller's objective is: maximize autonomy SUBJECT TO harm_rate staying at/near zero.
It never trades harm for throughput — a caused-incident contracts immediately (§3.3)
regardless of how many confirmed-good outcomes preceded it.
```

Two rates, not one, on purpose. `harm_rate` measures the auto-apply band. `l1_merged_harm_rate`
measures the **PROPOSE band** — the exact place attack #3 originates ("nobody is checking" is
a *rubber-stamp* problem, which happens at L1 where a human merges). If harm hid only in the
auto-apply denominator, a class doing damage through rubber-stamped L1 PRs would be invisible
to the safety number while its confirmed-good count climbs toward L1→L2. Tracking L1-merged
harm separately (a) closes that hole and (b) is the same evidence that gates the class's own
L1→L2 promotion (§3.2 uses the L1 actions' matured/caused outcomes directly). A class with a
non-trivial `l1_merged_harm_rate` cannot promote to auto-apply — its history disqualifies it
via condition 2.

`caused_incidents` counts *distinct actions that led to harm*, not raw incident count, so
one bad fix that recurs three times is one caused-incident, and one fix that both recurs *and*
gets reverted is still one caused-incident (deduped on action id).

### 6.2 Attribution — how machine harm is separated from ordinary incidents

Attribution is mechanical (§2.2), not a judgment call, so it is replayable and disputable:

- **recurrence** ← fingerprint OR (`module_area` + symptom-signature) match within `W_recur`.
- **spawn** ← new fingerprint first-seen within the touched `module_area` (rename-followed
  via `git log --follow`), within `W_spawn`, with no intervening *human* edit to the
  overlapping lines (condition (c)). Human-then-agent overlap ⇒ `spawn_contested`, counted
  for contraction, queued for adjudication.
- **revert** ← git revert of the applied commit, or human rewrite of the touched lines within
  `W_revert`.

Windows (defaults): `W_recur = 14d`, `W_spawn = 14d`, `W_revert = 30d`.

**Maturation is delayed past the LONGEST harm window, not the shortest.** A `matured` verdict
is evaluated strictly after `W_mature = max(W_recur, W_spawn, W_revert)` days (default 30d),
never at a shorter `W_confirm`. This closes the boundary race: if `matured` were emitted at
`W_recur=14d`, a same-day `recurrence` at the day-14 boundary could be beaten to the record
by the reconcile pass and a fix banked confirmed-good *on the day it recurred*. By deferring
`matured` to `max(W_recur, W_spawn, W_revert)`, every harm window has fully closed before an
action can be scored good. To make even the tie-at-`W_mature` case safe, harm events
dominate: within a single reconcile fold, if an action has both a harm event and a
maturation eligibility at the same instant, **harm wins** (see §7 tie-break). An action's
verdict is therefore never revised from `matured` back to caused — because `matured` cannot
be assigned until no harm event can still arrive.

### 6.3 Surfacing

Harm is not a buried counter — it is the headline of the controller's status:

- **Per-class harm_rate + l1_merged_harm_rate + trend** on the operator dashboard, next to
  each class's current level, `confirmed_good_rate`, `pending` count, and any active
  breaker/churn holds.
- **Every caused-incident** pushes a Telegram alert naming: the action id, the original
  incident, the demotion it triggered, and the **accountability owner** on record (D9).
- **`spawn_contested` queue** surfaced for human adjudication — the only place a human verdict
  re-enters the outcome pipeline, and it can only reclassify a contested event, never override
  a clean recurrence/revert.
- **A confounding guard on MTTR:** the dashboard shows MTTR *alongside* harm_rate and never in
  isolation, because a before/after MTTR improvement that ships harm is not net-positive
  (STRESS-TEST §9). "Net-positive" is unprovable without this pairing, so the controller
  refuses to display one without the other.

---

## 7. Determinism & replay contract

The "replayable byte-for-byte" claim is enforced, not asserted:

1. **All controller state is a pure fold** over the append-only outcome event stream. Given
   the same event log and the same config, the sequence of transitions is identical
   regardless of when it is computed.
2. **Canonical ordering.** Events are folded in order `(verdict_at ASC, kind_rank ASC,
   action_id ASC)`, where `kind_rank` orders harm before maturation
   (`recurrence=revert=spawn=spawn_contested < matured`) so the §6.2 tie-break is total and
   deterministic. `action_id` (a UUID) is the final, stable tie-break so no two events ever
   compare equal.
3. **`reconcile()` is a scheduler, not a decision-maker.** It only triggers the fold to run;
   the fold's *output is independent of cron cadence*. Running reconcile hourly, or once a day,
   or replaying the whole log from zero, yields the identical transition sequence and the
   identical final levels. Cron timing affects *when* an alert fires, never *whether* or *what
   level* a transition produces.
4. **Derived counters** (churn window §4.1, rate window §2.3, breaker windows §4.2) are all
   computed from the event/action tables filtered by timestamp — never from mutable in-memory
   accumulators that could diverge on restart. A cold start rebuilds every counter from the
   log.
5. **`effectiveLevel` is a pure function of (class state, touched areas, current holds)** —
   see §9 for its multi-area resolution rule, which is the one input that is not a single
   scalar.

Consequence: any transition in `trust_transition` can be re-derived from the events up to its
`at` timestamp, and the `evidence` JSONB snapshot lets an auditor reproduce the exact decision.

---

## 8. Feeding outcome-weight back to Incident Memory (closes attack #8)

Attack #8 (STRESS-TEST §8) is Incident Memory *poisoning*: a wrong-but-green past resolution
becomes few-shot context and propagates the same wrong fix — and the stress test flags that
it **compounds with #3**, the exact runaway this controller owns. The controller is the
authoritative source of the confirmed-good / caused verdict per action, so it must expose
that verdict for retrieval to be outcome-weighted (§8 fix in STRESS-TEST: "only confirmed-good
resolutions are positive exemplars; failures are retrieved as labeled anti-patterns").

Contract with INCIDENT-MEMORY.md:

- The controller exposes `outcomeWeight(actionId)` → `{ verdict, weight }`, where
  `verdict ∈ {pending, matured, recurrence, spawn, revert, spawn_contested}` and `weight` is
  `+1` for `matured`, `0` for `pending`, `-1` for any caused verdict.
- **INCIDENT-MEMORY.md MUST gate positive-exemplar retrieval on `verdict = 'matured'`.** A
  `pending` resolution is never a positive exemplar (its outcome is unknown). A caused
  resolution is retrievable **only as a labeled anti-pattern** (`weight = -1`), never as a
  "here's how we fixed it" example.
- Verdicts are revised by the controller only in the safe direction defined in §6.2 (a
  contested event may be cleared to `matured` after adjudication); Incident Memory reads the
  live verdict, so a resolution that later turns out caused stops being a positive exemplar
  automatically.

This is the coupling that stops #8 amplifying #3: the very outcome signal that gates autonomy
expansion also gates which past resolutions are allowed to teach the next fix.

---

## Data model (Postgres — reuses the AgenticMind instance per D1)

```sql
-- authoritative per-class autonomy state
create table trust_class (
  class_key        text primary key,          -- hash(loop, action_kind, module_area)
  loop             text not null,             -- B_flaky | B_heal | C_repair
  action_kind      text not null,
  module_area      text not null,
  level            smallint not null default 0,   -- 0..3 (L0..L3); effective level
  earned_level     smallint not null default 0,   -- level by evidence, ignoring kill override
  pre_kill_level   smallint,                      -- advisory snapshot only (§5), never used to raise
  owner            text,                          -- accountability owner (D9)
  cooldown_until   timestamptz,                   -- re-promotion frozen until this ts
  breaker_tripped  boolean not null default false,
  updated_at       timestamptz not null default now(),
  -- D9 (§3.6): no auto-apply level without a named owner
  constraint owner_required_for_autoapply
    check (level < 2 or owner is not null)
);

-- one row per applied action; the atom outcomes attach to.
-- applied_by discriminates machine auto-apply from human-approved L1 merge (§2.2) so BOTH
-- accrue outcomes — this is what makes L1→L2 promotion bootable.
create table auto_action (
  id             uuid primary key,
  class_key      text not null references trust_class(class_key),
  incident_id    uuid not null,
  applied_by     text not null,                   -- 'machine' | 'human_approved'
  touched_files  text[] not null,
  module_area    text not null,                   -- denormalized for rename-followed attribution
  applied_at     timestamptz not null,
  verdict        text not null default 'pending', -- pending|matured|recurrence|spawn|revert|spawn_contested
  verdict_at     timestamptz,
  why_trace_id   uuid not null                    -- replayable trace (cross-cutting)
);
create index on auto_action (class_key, applied_at);
create index on auto_action (module_area, applied_at);   -- churn (§4.1) + spawn attribution

-- immutable transition log (append-only; the audit surface)
create table trust_transition (
  id           bigserial primary key,
  class_key    text not null,
  from_level   smallint not null,
  to_level     smallint not null,
  reason       text not null,   -- promote|demote:recurrence|demote:spawn|demote:revert
                                 -- |demote:owner_cleared|churn_escalate|breaker:fail
                                 -- |breaker:reject|kill|resume|adjudicate
  evidence     jsonb not null,  -- counters snapshot at decision time (K, rate, window, caused, etc.)
  at           timestamptz not null default now()
);
```

`earned_level` vs `level` is the mechanism §5 relies on: KILL sets `level=0` for everyone but
leaves `earned_level` intact (and freeze-time demotions still write `earned_level`); RESUME
sets `level = min(earned_level, predicate_recheck())`, reading `earned_level` live and never
`pre_kill_level`.

---

## Config (checked-in, not prompt — governs the numbers above)

```yaml
trust_controller:
  window_M: 50                 # DECIDED outcomes per class considered for confirmed_good_rate (cond 2)
  promote:
    # D_min_days is BOTH the recency window for cond 3 (zero caused lately) AND the dwell for cond 4
    L1_to_L2: { K: 30,  theta: 0.98, D_min_days: 14 }
    L2_to_L3: { K: 100, theta: 0.99, D_min_days: 45 }   # Loop C only, + verification hard-gates
  demote:
    on_caused: to_level_1       # asymmetric: any caused-incident → straight to L1 (mutates earned_level)
    cooldown_days: 30
  attribution_windows:
    W_recur_days: 14
    W_spawn_days: 14
    W_revert_days: 30
    # W_mature is DERIVED = max(W_recur, W_spawn, W_revert); matured never emitted before it (§6.2)
  churn:
    H_hours: 6
    CHURN_MAX: 3                # actions per module_area per H → force-escalate area to L1
    CHURN_QUIET_hours: 12
  circuit_breaker:
    global_max_auto_actions_per_hour: 20
    per_class_consecutive_fail_trip: 3
    per_class_reject_trip: { count: 5, window_hours: 24 }   # rejects CONTRACT only, never expand
  invariants:                   # asserted at startup; process refuses to boot if violated
    low_override_rate_never_expands: true    # attack #3 guard, must stay true
    caused_incident_zero_required_to_promote: true
    owner_required_at_L2_and_above: true     # D9 (§3.6)
    # W_mature ≥ each attribution window is structurally guaranteed (it is their max),
    # and the startup check rejects any attribution window that is non-positive or
    # any config where a per-window value exceeds W_mature (defensive against manual override).
    mature_covers_all_harm_windows: true
```

Startup config validation (hard-fails the boot, same treatment as the invariant flags):
reject if any `W_*_days ≤ 0`; reject if `low_override_rate_never_expands` is false; reject if
`theta` is outside `(0, 1]`; reject if `K < 1` or `D_min_days < 1`. `W_mature` is computed,
not configured, so `matured < a harm window` is unrepresentable.

---

## Interfaces (TS-native, Claude Agent SDK stack)

```ts
// Consumed by the Risk Classifier / router (§5 of the original) and Loop B dispatcher.
// Deterministic; no LLM call in this module.
interface TrustController {
  // Authoritative effective level for a prospective action. Router MUST call this and MUST NOT
  // exceed the returned level, whatever the RCA/agent proposes. If touchedFiles span multiple
  // module_areas, returns the MINIMUM permitted level across all touched areas (safe floor),
  // AND applies any active churn hold on any touched area (§4.1). Pure function of current
  // class state + area holds; see §7.
  effectiveLevel(input: { loop: Loop; actionKind: string; touchedFiles: string[] }): Promise<AutonomyLevel>;

  // Called by Incident Memory's outcome projector on each event. Idempotent on action id.
  ingestOutcome(ev: OutcomeEvent): Promise<TransitionResult | null>; // null = no level change

  // Recompute promotions for classes whose windows advanced. SCHEDULER ONLY — the fold it
  // triggers is cadence-independent and replayable (§7). Safe to run at any interval or replay.
  reconcile(): Promise<TransitionResult[]>;

  // Outcome-weight surface read by INCIDENT-MEMORY.md to gate exemplar retrieval (§8).
  // weight: +1 matured, 0 pending, -1 any caused verdict. Closes attack #8.
  outcomeWeight(actionId: string): Promise<{ verdict: Verdict; weight: -1 | 0 | 1 }>;

  // Kill switch surface (§5).
  kill(reason: string, by: string): Promise<void>;
  resume(by: string): Promise<ResumeReport>;   // returns per-class pre/post map

  // Churn + breaker are updated on each apply/fail/reject; expose for the dashboard.
  status(): Promise<ClassStatus[]>;            // level, earned, harm_rate, l1_merged_harm_rate, cgr, pending, holds
}

type AutonomyLevel = 0 | 1 | 2 | 3;            // L0..L3
type Loop = 'A_rca' | 'B_flaky' | 'B_heal' | 'C_repair';
type Verdict = 'pending' | 'matured' | 'recurrence' | 'spawn' | 'spawn_contested' | 'revert';
type OutcomeEvent = {
  actionId: string;
  kind: 'applied' | 'recurrence' | 'spawn' | 'spawn_contested' | 'revert' | 'matured';
  at: string; // ISO — used as the canonical fold ordering key (§7)
};
```

Multi-area resolution rule (called out because it is the one place `effectiveLevel` is not a
single scalar): a diff touching `src/checkout` and `src/cart` returns
`min(level(checkout-class), level(cart-class))` and is additionally capped to L1 if *either*
area is under a churn hold. Taking the minimum is the safe choice — an action is only as
autonomous as its least-trusted touched area. This keeps the router's ceiling monotone and
never lets a cross-cutting diff inherit the higher of two trust levels.

The router treats `effectiveLevel` as a hard ceiling — the controller can only ever *lower*
what an agent is allowed to do, never raise it. That one-directional authority is what makes
this component the single throttle on attack #3.

---

## What this closes

- **Attack #3 (trust runaway, STRESS-TEST §3):** expansion is outcome-gated
  (recurrence/spawn/revert), never override-rate-gated; low rejection can only contract;
  promotion needs zero *recent* caused-incidents (cond 3), a clean *long-run* rate (cond 2),
  K confirmed-good, *and* calendar dwell so slow-surfacing harm has time to appear;
  contraction is instant on one caused-incident and writes through to `earned_level`. The
  positive-feedback path is severed, and it is severed for L1-merged actions too (the
  rubber-stamp band) via `l1_merged_harm_rate` feeding condition 2.
- **Attack #8 (Incident Memory poisoning, STRESS-TEST §8 — compounds with #3):** the
  controller's per-action verdict is the outcome-weight INCIDENT-MEMORY.md gates retrieval on;
  only `matured` resolutions are positive exemplars, caused resolutions surface only as labeled
  anti-patterns (§8). The signal that gates autonomy also gates what gets to teach the next fix.
- **STRESS-TEST §9 harm gap:** `harm_rate` (auto-apply) and `l1_merged_harm_rate` (propose)
  are defined, mechanically attributed on `module_area` with git rename-follow (so drift can't
  launder harm), deduped per action, made the primary optimized-against metric, and shown
  paired with MTTR so net-positive is provable rather than asserted.
- **STRESS-TEST §9 fingerprint drift:** class key, recurrence match, and spawn attribution are
  *all* area-scoped + rename-followed, so a refactor resets neither earned trust nor harm
  attribution — the drift gap is closed on both sides symmetrically.
- **Same-area diff-stacking (net-new guard, §4.1):** an area-keyed churn counter
  force-escalates a hot area to human review regardless of earned trust, blocks promotion of
  any class in that area (cond 6), and requires the area to *settle* before autonomy returns.
  Stated as an addition, not as a citation to a stress-test finding that does not exist.
```
