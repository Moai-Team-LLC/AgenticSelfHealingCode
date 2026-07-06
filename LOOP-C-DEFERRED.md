# Loop C — Deferred Autonomous Production-Code Repair (spec)

The original centerpiece (`ARCHITECTURE-ORIGINAL.md` §1–§8: Signal → RCA → Repair Worker →
Gate → auto-apply), demoted to a deferred, per-incident-class, outcome-earned tail (D5). This
doc makes the deferral, the earn-conditions, and the mechanics **buildable** — without
pretending Loop C ships in v1. It owns *no* new machinery: the gate is `VERIFICATION-GATE.md`,
the promotion law is `TRUST-CONTROLLER.md`, the sandbox and least-priv are
`SECURITY-THREATMODEL.md`, the apply-time write path and kill bit are `ORCHESTRATION.md`, the
approval ladder and business-hours gate are `HITL-APPROVAL.md`. Loop C is the *composition* of
those, plus the repair-worker cycle, activated per-class only when the Trust Controller says a
class earned it.

Stack, per D1: TS-native (Claude Agent SDK), Postgres+pgvector reused from AgenticMind, GitHub
Actions CI, Telegram HITL bot. **No new runtime** — Loop C runs on the same AgenticOps durable
Postgres state machine as everything else (`ORCHESTRATION.md`). Cross-cutting invariants hold
everywhere: replayable why-trace, immutable hash-chained audit log (`SECURITY-THREATMODEL.md`
§7.2), kill switch honored (§7).

**Status (updated).** The *autonomous* rung — **L2/L3 auto-apply, no human in the loop** — is
DEFERRED: earned later, per-class, on this system's own measured outcome data; nothing in this doc
about auto-apply is built. But the **L1 rung this doc already specified as the v1 behavior** (§5.1:
*"every Loop C fix is an L1 PR for HITL, propose-only, human-merged, never auto-merged"*) is now
**BUILT** — package **`@sho/loop-c`** (propose → grounded-repro invariant → non-LLM gate → PR + L1
approval → human confirms via PR merge **or** Telegram → `human_approved` landing). This matches the
Trust Controller's own base case (`effectiveLevel` returns L1 — *"nothing is auto by default"*). So
"deferred" now means precisely **auto-apply is deferred**; human-confirmed repair is not. The spec still
exists so that *when* a class earns L2/L3, the path is already governed — never bolted on after the fact
(`TRUST-CONTROLLER.md` scope note).

---

## 1. Why deferred, not deleted — the funnel and what survives

Loop C is not cancelled; it is **starved of standing until data earns it**. The reason is
structural, from `STRESS-TEST.md` §1 (the central attack), not a matter of taste or maturity.

### 1.1 The safe zone and the bug zone are nearly disjoint

Walk the auto-apply predicate honestly. For a production bug to be autonomously repairable it
must be **simultaneously**:

- reproducible from telemetry against real repo state **without prod data** (grounded repro,
  D2 — bounded by the schema-only sandbox, `SECURITY-THREATMODEL.md` §4.2);
- small-diff, inside a single `module_area`, within the class diff budget;
- in a module strong enough that a wrong change would be *caught* — i.e. high mutation score
  (D4, `VERIFICATION-GATE.md` S5);
- outside all protected paths (`ARCHITECTURE-REFRAMED.md` §3.4 `protected_paths`);
- side-effect-free / proven-reversible (D2, `VERIFICATION-GATE.md` §6 / S8);
- confidently and *correctly* root-caused (grounded booleans, not LLM self-report — D3).

The precondition for safe auto-fix (a strong, mutation-killing suite over the touched module)
is **anti-correlated** with the precondition for the bug having existed at all (a weak suite
let it reach production). Principle 6 (`ARCHITECTURE-ORIGINAL.md` §0.6) is not a phase-gate
cleared once — it is a *permanent squeeze* (D4; the gate makes a weak module permanently
ineligible for auto-apply, `VERIFICATION-GATE.md` S5). Stack on this the original §15 / STRESS
§1 admission — most incidents are **config / data / capacity / upstream**, which code-only
repair workers cannot touch at all — and autonomous production repair is a **minority of a
minority**.

### 1.2 The funnel (direction, not fake precision)

The point is the *shape*, not the numbers. Every stage below is a strict subset of the one
above it, and each cut is one of the constraints in §1.1:

```
all incidents
  └─ not config/data/capacity/upstream (i.e. actually a CODE bug)        ── large cut (STRESS §1)
       └─ reproducible from schema-only sandbox, no prod data (D2/§4.2)  ── large cut
            └─ in a strongly-mutation-covered module (D4)                ── large cut (the §1.1 anti-correlation)
                 └─ small-diff, non-protected, side-effect-free (D2)     ── cut
                      └─ class has EARNED L2/L3 on outcome data (D6)      ── time+evidence gate
                           └─  ← the auto-apply-eligible tail
```

No percentages are asserted — the honest claim is directional: **each layer removes most of
what the layer above admitted, so the eligible tail is small, and it is discovered per-class on
outcome data, never architected up-front.** Loop A is, by contrast, "~80% of the value, ~10% of
the risk" (`STRESS-TEST.md` "What survives") — *conditional on D10* (`ARCHITECTURE-REFRAMED.md`
§0), which is exactly why the center of gravity moved to Loop A + Loop B and Loop C waits.

### 1.3 What survives (why deferred beats deleted)

Loop C is retained, not deleted, because the funnel does not go to zero — a genuinely narrow
tail of incident-classes *is* code bugs, in strong modules, schema-reproducible, side-effect-
free. For **those** classes, autonomous repair is real value. But which classes those are is
**not knowable in advance** — it is an empirical fact about *this* codebase and *this* incident
stream, revealed only by running Loops A/B, watching outcomes, and letting the Trust Controller
promote a class after it has earned it. Deferring is therefore not "maybe later, vaguely"; it is
a precise stance:

> Build every upstream capability now (§8), leave Loop C's *write standing* at L1 for every
> class, and let the Trust Controller unlock L2/L3 **per-class, on measured outcomes** — never
> by architecting an auto-repair centerpiece first (D5). The only truly D10-contingent
> capability in the whole system is Loop C's autonomous write to production code
> (`ARCHITECTURE-REFRAMED.md` §8).

---

## 2. Earn conditions (owned by `TRUST-CONTROLLER.md`; referenced, not re-derived)

A Loop C incident-class reaches an auto-apply level (L2/L3 in the crosswalk,
`ARCHITECTURE-REFRAMED.md` §2) **only** through the Trust Controller's promotion predicate. This
spec does **not** restate the control law; it names the conditions and points at the authority.

The `class_key` for a Loop C class is `(module_area, symptom_signature)`
(`ARCHITECTURE-REFRAMED.md` §6), under `loop = C_repair`, `action_kind ∈ {null_guard,
off_by_one, config_patch, ...}` (`TRUST-CONTROLLER.md` §2.1). Two column vocabularies for the same
loop, do not conflate: the **class taxonomy** uses `trust_class.loop = 'C_repair'`
(`TRUST-CONTROLLER.md` §2.1), while the **write-path** row that lands uses
`auto_action.loop = 'C'` (`ARCHITECTURE-REFRAMED.md` §3.2 DDL enum, `CHECK (loop IN ('B','C'))`).
A `C_repair` class **starts pinned at L1** (`TRUST-CONTROLLER.md` scope note) — propose-only,
human-merged — and stays there until **every** promotion condition holds
(`TRUST-CONTROLLER.md` §3.2, AND not OR):

1. **≥ K confirmed_good outcomes** in the class at the current level (`confirmed_good = matured`
   verdicts; L1→L2 `K=30`, L2→L3 `K=100`). A `matured` verdict is only assignable after
   `W_mature = max(W_recur, W_spawn, W_revert) = 30d` (`ARCHITECTURE-REFRAMED.md` §3.5,
   `TRUST-CONTROLLER.md` §6.2) — never a shorter window; `W_confirm` is deleted.
2. **`confirmed_good_rate ≥ θ`** over the M-decided-outcome window (long-run track record;
   L1→L2 `θ=0.98`, L2→L3 `θ=0.99`) — caps the class's *lifetime* caused-share independently of
   any recent clean streak (`TRUST-CONTROLLER.md` §2.3 / §3.2 condition 2).
3. **Zero caused-incidents in the recent `D_min` window** (strict zero, not a floor;
   `TRUST-CONTROLLER.md` §3.2 condition 3), **plus calendar dwell** `≥ D_min` days
   (condition 4 — slow-surfacing harm must have had *time* to appear). `D_min` is
   **per-transition**, not global: `D_min=14d` for L1→L2, `D_min=45d` for L2→L3
   (`TRUST-CONTROLLER.md` §3.2 default table / `trust_controller.yaml`). Because Loop C is the
   *only* consumer of the L2→L3 row, its steepest gate — 45d of zero-caused dwell — is Loop C's,
   deliberately: an auto-apply class widening its blast radius must clear a month and a half of
   clean recent outcomes, not a fortnight.
4. **Mutation bar met** — the class's touched modules clear `max(floor, requiredMutationScore)`
   at action time, the effective bar supplied by `TRUST-CONTROLLER.md` (`VERIFICATION-GATE.md`
   S5, `ARCHITECTURE-REFRAMED.md` §2). A weak module permanently disqualifies its class.
5. **Named accountability owner on record** — `trust_class.owner` non-null (D9; the single
   source is `trust_class.owner`, `ARCHITECTURE-REFRAMED.md` §3.3; `TRUST-CONTROLLER.md` §3.6
   forbids L2+ with a null owner).
6. **No open circuit-breaker trip, no active churn hold** on the class's `module_area`
   (`TRUST-CONTROLLER.md` §3.2 conditions 5–6, §4).
7. **(L2→L3 only) the L3 hard-gates** in `TRUST-CONTROLLER.md` §3.5 — grounded repro, mutation,
   proven side-effect-free, business-hours window + fast-rollback + traffic cap, named owner —
   checked *at action time* by the Verification Gate.

**Plus D10 evidence if remediation-heavy.** Because Loop C is the only capability contingent on
the D10 verdict (`ARCHITECTURE-REFRAMED.md` §8, D10): if `D10-INSTRUMENT.md` found the operator
is *remediation-heavy* (fix CI/deploy/review friction first), a class does not begin earning
Loop C standing until that friction is addressed conventionally and the per-class D10 override
data supports it. If diagnosis-heavy, the earn-path proceeds on outcome data as above. Loop C is
never architected first regardless (D5).

**Asymmetric — one caused-incident demotes immediately.** Promotion takes K outcomes and D_min
days of dwell; contraction takes **one** event. A single caused-incident (`recurrence | spawn |
revert | spawn_contested`) attributed to the class drops it **straight to L1**, mutating both
`level` and `earned_level`, with a `C_cool=30d` re-promotion freeze, and the caused-incident
keeps weighing against condition 2 as it ages (`TRUST-CONTROLLER.md` §3.3). This asymmetry — 
outcomes expand slowly, harm contracts instantly — is the whole point, and it is the Trust
Controller's, not Loop C's: **Loop C never decides its own autonomy.** It requests
`effectiveLevel(...)` from the controller and treats the answer as a hard ceiling
(`TRUST-CONTROLLER.md` interfaces).

---

## 3. Repair workers (from `ARCHITECTURE-ORIGINAL.md` §6 + `SECURITY-THREATMODEL.md`)

Two specialized subagents, not one generalist — frontend and backend have different test
runners, linters, and conventions (`ARCHITECTURE-ORIGINAL.md` §6):

- **`backend-fix-agent`** — server code, schema *DDL read-only* (schema, never data,
  `SECURITY-THREATMODEL.md` §4.2), integration tests.
- **`frontend-fix-agent`** — UI code, component/snapshot tests, visual regression.

Both run under the deferred Loop C identity `sho-repair` (`SECURITY-THREATMODEL.md` §5.1) inside
the **ephemeral sandbox** owned by `SECURITY-THREATMODEL.md` §4 — this spec does not re-specify
the container, it *consumes* it:

- **Ephemeral, isolated container per incident** — one per task, destroyed on completion
  (success, failure, or timeout); no reuse, no state carried between a poisoned run and a clean
  one; non-root, read-only root FS, `--cap-drop=ALL`, seccomp default-deny, memory/CPU/PID caps,
  hard wall-clock timeout (`SECURITY-THREATMODEL.md` §4.1).
- **Clean clone, no prod secrets, no prod reachability** — repo clone only; no `.env`, no cloud
  creds, no prod DB string, no service-mesh identity; prod network unreachable by routing; DB
  needs met by **schema DDL dump only, no data** (`SECURITY-THREATMODEL.md` §4.2). This is
  exactly why §1.1's grounded-repro constraint bites (§4 below).
- **Egress deny-by-default** — outbound denied except a pinned proxy for the *existing*
  lockfile; frozen-lockfile / `--offline` install so a well-formed run needs zero registry
  egress; every blocked attempt audited (`SECURITY-THREATMODEL.md` §4.3). No new dependencies
  (diff-policy check, `SECURITY-THREATMODEL.md` §4.4).

**Allowed vs forbidden** (the `sho-repair` least-privilege tool allow-list,
`SECURITY-THREATMODEL.md` §3.3 / §5.1 — enforced server-side by the harness and GitHub branch
protection, **not** by prompt):

| Allowed | Forbidden |
|---|---|
| read/write the repo clone in the sandbox workdir | write outside the sandbox tmp / clone |
| run tests, lint, static analysis, mutation (via the gate) | infra-changing commands, IaC |
| `code_search`, `git_read` (blame/log/diff), `memory_retrieve` | access to secrets, `.env`, prod DB, service-mesh identity |
| `sandbox_exec` (repro/patch inside the container) | network egress beyond the §4.3 allow-list |
| `git_write_branch` on **non-protected** paths (`src/**`) | `git_write` to `protected_paths` (`src/auth/**`, `src/billing/**`, `infra/**`, `**/migrations/**`, secrets, `.github/**`) |
| `pr_open` | `merge`, direct push to `main`, force-push |

The forbidden column is not policy the agent is asked to respect — it is the required path-guard
CI status check plus branch protection (`SECURITY-THREATMODEL.md` §5.2). Even a fully-steered
`sho-repair` bottoms out at a blocked, audited PR on a branch (`SECURITY-THREATMODEL.md` §5.4) —
the concrete refutation of attack #7.

---

## 4. The grounded repro cycle (D2 / D3) — mandatory, bounded, non-self-reporting

This is Loop C's core loop, and its confidence is **observed booleans, never self-report** (D3).
The original §6 marked repro *optional*; here it is **mandatory** for any Loop C write — it is
the only grounded-confidence source (`STRESS-TEST.md` §2, D2). A fix that cannot reproduce the
signal against real repo state and flip it green does not proceed to auto-apply, full stop.

### 4.1 The cycle

```
input: incident (grounded RCA hypothesis from Loop A why-trace, LOOP-A-SPEC.md),
       resolved (loop=C, tier, requiredMutationScore, accountabilityOwner) from the
       ORCHESTRATION.md router (ARCHITECTURE-REFRAMED.md §2)

iterate until GREEN or budget exhausted:
  1. REPRODUCE   — in the sandbox, reproduce the signal from ACTUAL repo state at parentSHA.
                   Author a regression test that captures the reported failure.
                   ── grounded boolean: repro_reproduced_signal ∈ {true,false}
                   If false → the signal does not reproduce against real code (forged /
                   misattributed / data-dependent). STOP: not auto-appliable; hand to human
                   as a Loop A trace (SECURITY-THREATMODEL.md §2.4).
  2. PATCH       — backend-fix-agent | frontend-fix-agent proposes a minimal diff on
                   non-protected paths only (§3).
  3. FLIP GREEN  — run the regression test on fixSHA.
                   ── grounded boolean: fix_flipped_repro_green ∈ {true,false}
  4. GATE        — hand (parentSHA, fixSHA, loop=C, tier, requiredMutationScore,
                   accountabilityOwner) to VERIFICATION-GATE.md. It runs the non-LLM battery:
                     S4 must-fail-on-parent (the regression test fails on parent for BEHAVIOR,
                        passes on fix — kills the vacuous self-graded test, STRESS §4)
                     S5 mutation score on touchedModules ≥ max(floor, requiredMutationScore)
                     S6 no-weakening (the fix must not loosen any assertion it touches)
                     S7 static/security (semgrep)
                     S8 reversibility probe (proven side-effect-free — the L2/L3 auto-apply
                        action-time gate; `VERIFICATION-GATE.md` §6 marks S8 R for every auto column)
                     S9 judge = ADVISORY only (fed signals+diff, RCA demoted to untrusted claim)
  5. DECIDE
       gate PASS  → proceed to routing (§5). Confidence = the conjunction of grounded booleans
                    (repro_reproduced ∧ fix_flipped ∧ S4 ∧ S5 ∧ S6 ∧ S8), NEVER an LLM number.
       gate FAIL  → if iterations/tokens remain, feed the failing SIGNAL back and retry from 2.
                    else EXHAUSTED → STOP.

on EXHAUSTED (budget hit without a green gate):
  STOP. Do NOT loop forever. Escalate to a human with the PARTIAL work — the best diff, the
  gate signals that failed, and a plain explanation of what did not converge — as an L1 hand-off
  (ARCHITECTURE-ORIGINAL.md §6: "stops and escalates with partial work, not infinite loop").
```

**The repro budget is Loop C's own bounded edge.** The `iterations`/`tokens` ceiling above is
`loop_c.repro_budget` (default `max_iterations: 4`, `max_tokens` per the orchestrator's per-step
budget), a checked-in config owned by this spec — enforced by the `ORCHESTRATION.md` durable step
runner (D1: no new runtime; the same AgenticOps state machine bounds every step), never by the
agent's own judgement. Exceeding it is a hard STOP-and-escalate, not a soft nudge: the budget is
what makes "iterate to green" terminate rather than burn tokens against an unreproducible or
unfixable signal. This is the one loop-termination guarantee Loop C owns directly; every other
bound (rate cap, churn hold, breaker) is the Trust Controller's (`TRUST-CONTROLLER.md` §4).

### 4.2 Confidence is the observed booleans, never self-report (D3)

The gate's authority is causally independent of the model that wrote the fix
(`VERIFICATION-GATE.md` §1 independence principle, D8). Loop C therefore never gates on a
self-reported confidence score. `confidence_selfreport` may be *stored* for later analysis
(`INCIDENT-MEMORY.md`, per D3) but is **never** a gate input. The `JudgeVerdict` has no
confidence field by construction (`VERIFICATION-GATE.md` §4, D3). A confidently-wrong RCA cannot
talk its way past S4/S5/S8 — those are mutation tools, must-fail re-runs, and a reversibility
probe, which share no blind spot with the author.

### 4.3 The schema-only limit is honest, not papered over

Step 1 can only succeed for incident classes reproducible **without representative prod data**
(`SECURITY-THREATMODEL.md` §4.2, D2). A bug that only manifests with specific accumulated state
cannot be reproduced from an empty schema, so `repro_reproduced_signal` is `false` and the class
never enters the auto-apply funnel. That is a **scope limit by construction, not a gap** — see
§6. Within the reproducible scope, a spoofed signal that does not reproduce against real code
dead-ends here (`SECURITY-THREATMODEL.md` §2.4) — grounded repro is *also* the anti-spoof
backstop.

---

## 5. Routing at v1 vs earned

Loop C's write standing is entirely a function of what the Trust Controller has granted the
class. There is no default auto-apply.

### 5.1 v1 (and every not-yet-earned class): L1 PR for HITL, NEVER auto-merged

Every Loop C fix is opened as a **PR for the async HITL ladder** (`HITL-APPROVAL.md`) —
propose-only, human-merged. It is **never auto-merged in v1**. The human approver who merges is
the `accountable_owner` of record (D9); the merge is the human's identity, not a service account
(`SECURITY-THREATMODEL.md` §5.1). On merge, the apply-time writer in `ORCHESTRATION.md`
(`ARCHITECTURE-REFRAMED.md` §3.2) inserts exactly one `auto_action` row:

```sql
-- inserted by ORCHESTRATION.md apply-time writer (ARCHITECTURE-REFRAMED.md §3.2); DDL owned there.
-- Loop C L1 merge → applied_by = 'human_approved'   (the assisted_action the ladder needs)
-- Loop C auto-apply (deferred, earned) → applied_by = 'machine'
--   loop = 'C', accountable_owner materialized from trust_class.owner (D9), gate_result = the
--   GateResult that cleared it, module_area for churn+spawn attribution.
```

This row is **not** `NULL` for human-merged Loop C PRs (`ARCHITECTURE-REFRAMED.md` §3.2 corrects
the old "NULL for human-merged" contradiction). It is precisely the evidence that lets a
`C_repair` class **earn** L1→L2: without a scoreable atom for the human-approved merge, the
promotion ladder is dead on arrival (D6 BLOCKER #3). Incident Memory projects its outcomes to
`OutcomeEvent{ actionId, kind, at }` (the canonical field is **`actionId`**, not
`autoActionId`, `ARCHITECTURE-REFRAMED.md` §3.2), which the Trust Controller folds.

### 5.2 Earned: L2/L3 auto-apply, per-class, business-hours, proven-reversible

Only after a class clears §2 does the router return an auto-apply level for it. When it does:

- **Auto-apply is business-hours-gated** (staffed hours) unless the class *separately* earned
  off-hours on outcome data — owned end-to-end by `HITL-APPROVAL.md` §2 (this closes the
  `STRESS-TEST.md` §6 async-HITL inversion: no ungated write runs 24/7 while gated tiers sleep).
- **Proven-reversible** — the `VERIFICATION-GATE.md` §6 / S8 positive-attestation probe must
  pass (module on `side_effect_free_modules` allowlist + mechanical probe), not merely "a revert
  commit is ready" (D2, `STRESS-TEST.md` §9).
- **Named owner** materialized into `auto_action.accountable_owner`, frozen at apply time
  (`ARCHITECTURE-REFRAMED.md` §3.3); the gate hard-FAILs the auto column if the input
  `accountabilityOwner` is null (`VERIFICATION-GATE.md` §5).
- **Kill switch honored** — the gate returns `frozen` and blocks auto-apply, PR-open, and HITL
  ping alike when the kill bit (owned by `ORCHESTRATION.md`, §7) is engaged.

The auto-apply commit lands via the apply-time writer with `applied_by = 'machine'`. Loop C
auto-merge, if ever earned, uses a *separate, per-class* identity — never the general repair
account (`SECURITY-THREATMODEL.md` §5.1).

### 5.3 Tier 4 / protected paths: NEVER autonomous

Migrations, auth, billing, infra, secrets, CI config — Tier 4 — are **never autonomous at any
level** (`ARCHITECTURE-REFRAMED.md` §3.1 tier table; `protected_paths` §3.4). The path-guard
required CI check hard-blocks any bot write to a protected path server-side
(`SECURITY-THREATMODEL.md` §5.2); the agent may propose a *plan* only, with synchronous human
approval before any code change. There is no earn-path out of this — it is a hard block, not a
trust level.

### 5.4 The router hands Loop C its tuple; Loop C never picks its own tier

Loop C never assigns its own tier or mutation bar. The `ORCHESTRATION.md` router
(`ARCHITECTURE-REFRAMED.md` §2) resolves `L := TrustController.effectiveLevel(class)`,
`tier := crosswalk(L)`, `reqMut := TrustController.requiredMutationScore(class)`,
`owner := TrustController.accountabilityOwner(class)` and hands the resolved tuple to the gate.
The `effectiveLevel(class)` shorthand above (inherited from the keystone router, `ARCHITECTURE-REFRAMED.md`
§2) is exactly that — shorthand. The **real interface** takes a 3-field input the router derives
from the incident, not an opaque class token: `effectiveLevel(input: { loop: 'C_repair',
actionKind, touchedFiles })` (`TRUST-CONTROLLER.md` interfaces). Loop C is the component that
assembles those fields — `loop` is fixed `'C_repair'`, `actionKind` comes from the RCA-classified
fix kind, and `touchedFiles` is the repair worker's proposed diff file set — so the controller can
take the **minimum** permitted level across every touched `module_area` and cap to L1 if any touched
area is under a churn hold (`TRUST-CONTROLLER.md` interfaces / §4.1). `effectiveLevel` is a hard
ceiling; the gate consumes the resolved tuple and never moves the tier (split-brain avoidance,
`VERIFICATION-GATE.md` §1).

**Diff-stacking is guarded by the churn escalator (net-new guard), not by Loop C.** Three
separate small green Loop C fixes stacking into one `module_area` within the window each pass the
stateless gate individually; the compounding mess is caught by the **area-keyed churn escalator**
owned by `TRUST-CONTROLLER.md` §4.1 (`CHURN_MAX=3` actions per area per `H=6h` → force-escalate
every further action in that area to L1 and set a churn hold until the area settles
`CHURN_QUIET=12h`). It is fed by the gate's per-run `moduleArea` / `diffLines` fields
(`VERIFICATION-GATE.md` GateResult). This is a net-new guard, **not** "attack #11" —
`STRESS-TEST.md` has only §1–§9; the canonical name is the **churn escalator**
(`ARCHITECTURE-REFRAMED.md` §2).

---

## 6. What keeps a class Loop-A-forever (where autonomy ends)

Some incident-classes never enter the Loop C funnel at all. These are not "Loop C not yet
earned" — they are **structurally ineligible**, and the system hands them to a human as a Loop A
why-trace forever (`ARCHITECTURE-REFRAMED.md` §7 "where autonomy ends"):

- **Data-dependent classes** — not reproducible from a schema-only sandbox
  (`SECURITY-THREATMODEL.md` §4.2, D2). Grounded repro (§4) *never fires* for them, so they can
  never produce grounded confidence, so they can never auto-apply. Loop A forever.
- **Config / data / capacity / upstream incidents** — the majority of incidents
  (`ARCHITECTURE-ORIGINAL.md` §15, `STRESS-TEST.md` §1). Code-only repair workers cannot touch
  them; there is nothing in the repo for Loop C to fix.
- **Architectural decisions, not patches** — a problem needing a design change, not a diff
  (`ARCHITECTURE-REFRAMED.md` §7).
- **Capacity / scaling planning** — human judgment (`ARCHITECTURE-REFRAMED.md` §7).
- **Security incidents** — human judgment, never an autopatch (`ARCHITECTURE-REFRAMED.md` §7).
- **Ambiguous business/product logic** — a fix whose correctness depends on a product decision
  not derivable from code (`ARCHITECTURE-REFRAMED.md` §7).
- **Permanently weak modules** — any class whose touched module cannot clear the mutation bar
  stays ineligible for auto-apply *permanently*, not as a one-time phase gate (D4,
  `VERIFICATION-GATE.md` S5; `ARCHITECTURE-ORIGINAL.md` principle 6, the permanent squeeze).

For all of these, Loop C degrades gracefully to Loop A: the RCA copilot produces a grounded
why-trace and hands it to the on-call human (`LOOP-A-SPEC.md`), who does the fix. That is not a
failure of Loop C — it is the design. The eligible tail (§1.2) is deliberately small; everything
outside it is a human's, informed by the diagnosis.

---

## 7. Kill switch, audit, why-trace (cross-cutting, honored not owned)

Loop C owns none of these; it honors all of them:

- **Kill switch.** The authoritative kill bit lives in `ORCHESTRATION.md`
  (`ARCHITECTURE-REFRAMED.md` §5), fail-safe (absence of a healthy heartbeat = KILL,
  `SECURITY-THREATMODEL.md` §7.1). When engaged, the Trust Controller forces every class's
  `effectiveLevel → L0`, so the router hands Loop C L0 and no write is authored; the gate returns
  `frozen` and blocks auto-apply, PR-open, and HITL ping (`VERIFICATION-GATE.md` §7). No agent
  tool can toggle the bit; release is a signed on-call action over the authenticated HITL channel
  (`HITL-APPROVAL.md`). A mid-flight Loop C fix cannot slip a write through — the orchestrator
  checks the bit at every tier-transition guard (`ARCHITECTURE-REFRAMED.md` §5).
- **Immutable audit log.** Every Loop C tool call, gate run, PR-open, and merge appends to the
  hash-chained, externally-anchored audit log (`SECURITY-THREATMODEL.md` §7.2). The record is
  written **before** merge (fail-closed: no audit append → no merge, `SECURITY-THREATMODEL.md`
  §6.2).
- **Replayable why-trace.** Every Loop C incident carries a `why_trace_id`
  (`ARCHITECTURE-REFRAMED.md` §3.2 `auto_action`, `TRUST-CONTROLLER.md` data model) linking
  signal → RCA hypothesis → grounded-repro booleans → gate signals → diff → outcome, so "why was
  this auto-applied / why wasn't it" is always answerable from the log.

---

## 8. Build order — Loop C is the one thing NOT built now

Per `ARCHITECTURE-REFRAMED.md` §8 and D5/D10: everything upstream of a *write* serves Loops A, B,
and C and is built now — signal layer + authenticated ingestion, dedup, Incident Memory, the
durable orchestrator (router, `notify_state`, apply-time writer, kill bit), the Verification
Gate, the Trust Controller, the HITL bot + audit log + kill switch. Loop B ships in v1 regardless
of the D10 verdict. **Loop C is the only capability that genuinely waits** — earned per-class on
outcome data after the D10 verdict, never architected first.

| What | Built now? | Contingent on D10? |
|---|---|---|
| Upstream-of-write capabilities (signal, dedup, memory, orchestrator, gate, controller, HITL) | Yes | No — serve A, B, and C |
| Loop A (RCA copilot) | if diagnosis-heavy | Yes (the v1 product) |
| Loop B (test-suite self-healing) | **Yes, always** | No |
| **Loop C — L1 (propose + human-confirm, §5.1)** | **Yes** (`@sho/loop-c`) | No — it is the governed v1 rung |
| **Loop C — L2/L3 (auto-apply, no human)** | **No** | **Yes** — earned per-class on outcome (D6), after D10, never first |

The only remaining unbuilt piece for L1 to run against a live repo is the **sandboxed repair worker** — the
Claude patch-proposer inside the ephemeral, secret-less, egress-denied container (§3, `SECURITY-THREATMODEL.md`
§4) that authors the diff and drives the grounded repro cycle (§4). `@sho/loop-c` defines that worker as the
`RepairAuthor` port (with in-memory fakes) and ships everything *around* it — the protected-path block, the
grounded-repro invariant, the gate call, the PR channel, the L1 approval, and the `human_approved` landing —
so activating it is plugging a governed brain into a built harness, never bolting governance on afterward.

So when a `C_repair` class eventually earns L2/L3, no new machinery is written — the gate, the
controller, the apply-time writer, the sandbox, the audit log, and the HITL ladder already exist
and already govern it. Loop C is their composition, activated one class at a time, on the
system's own measured evidence that the class did no harm.

---

**Bottom line.** Loop C is deferred because the safe zone and the bug zone are nearly disjoint —
autonomous production repair is a minority of a minority (§1), earned per-incident-class on
outcome data, never architected first (D5). A class reaches auto-apply only after ≥K
confirmed_good, `confirmed_good_rate ≥ θ`, zero recent caused-incidents, the mutation bar, a
named owner, and (if remediation-heavy) D10 evidence — asymmetric, so one caused-incident demotes
it instantly (§2, `TRUST-CONTROLLER.md`). Repair workers run in the ephemeral, secret-less,
egress-denied sandbox (§3, `SECURITY-THREATMODEL.md`). Every fix runs the mandatory grounded
repro cycle — reproduce, patch, flip green, clear the non-LLM gate — with confidence as observed
booleans, never self-report, and it stops with partial work rather than looping forever (§4). At
v1 every Loop C fix is an L1 PR for HITL, never auto-merged; auto-apply is per-class-earned,
business-hours, proven-reversible; Tier 4 / protected paths are never autonomous (§5). And the
data-dependent, config/capacity/security/architectural, and permanently-weak classes stay Loop A
forever (§6). Loop C owns no new machinery — it composes the gate, the controller, the sandbox,
the apply-time writer, and the HITL ladder, and is the one capability the whole system does not
build first.
