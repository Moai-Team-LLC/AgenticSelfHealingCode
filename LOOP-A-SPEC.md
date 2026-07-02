# Loop A — RCA Copilot (spec)

> **Reconciliation note.** `ARCHITECTURE-REFRAMED.md` is the source of truth for cross-component
> contracts. Aligned here: `provisional_human_confirmed` is a **stored** outcome label (keystone §3.6),
> distinguishable from both `proposed` and `confirmed_good`; `notify_state` and its durable compare-and-set
> are owned by `ORCHESTRATION.md` (keystone §5) — this spec consumes them.

The v1 product. Signal → dedup → RCA investigation agent → **grounded why-trace** handed to
the on-call human. Tier 1 forever: **zero write access to application code**. It reads
telemetry, code, and history; it produces an explained hypothesis with observable evidence;
a human decides and acts. It never opens a PR against app code, never merges, never touches
prod. Loop A is where ~80% of the value sits at ~10% of the risk (STRESS-TEST §"What survives").

Loop A shares the durable state machine and Incident Memory with the rest of the system but is
the only loop that ships with autonomy on day one, because its worst-case output is a *wrong
suggestion a human reads and rejects* — not a bad write.

Cross-refs: signal contract origin in ARCHITECTURE-ORIGINAL §2; test-suite loop in
LOOP-B-SPEC.md; memory schema and the **outcome watcher** in INCIDENT-MEMORY.md; the shared
signal/gate machinery in VERIFICATION-GATE.md; the reframe and the D6/D10 instruments in
ARCHITECTURE-REFRAMED.md.

---

## 1. Purpose & scope

**Does:**
- Consumes deduped Incident Candidates (§2).
- Runs a bounded investigation agent (§3) over code, git history, deploy diffs, correlated
  traces/logs, and past incidents.
- Emits a structured **why-trace** (§5): signal → evidence → ranked hypothesis + alternatives →
  grounded-confidence booleans → recommended human action. Fully replayable.
- Delivers a compressed, human-facing enriched-incident payload to the on-call engineer (§7)
  over the Telegram HITL bot with a deep-link to the full trace.
- Writes the closed trace (including the human's eventual confirmed cause / action) back to
  Incident Memory as a labeled outcome for future retrieval (§6, INCIDENT-MEMORY.md).

**Does NOT (hard boundaries, enforced by the service-account scope, not by prompt):**
- **Never edits, patches, or writes application code.** No repo write token in Loop A's
  service account. Git access is read-only (`blame`, `log`, `show`, `diff`).
- Never opens a PR, never merges, never triggers a deploy or rollback. It *recommends* a
  rollback; the human runs it.
- Never mutates infra, secrets, feature flags, or the prod database.
- Never auto-decides below the grounded-confidence gate (§4) — it escalates with partial
  findings rather than guessing (ARCHITECTURE-ORIGINAL §4).

**On the sandbox.** `repro.sandbox` (§3) is a **read-only reproduction harness**, not the
mandatory auto-apply gate that D2 defines for Loop C. In Loop A it is *optional*, and that is
correct: Loop A never auto-applies anything, so there is no write to ground. But being optional
has a **consequence the gate must own** (§4): a sandbox reproduction is the strongest grounding
signal, so incidents that can be reproduced reach CONFIRMED far more readily than those that
cannot. The gate therefore provides grounding paths that do **not** depend on the sandbox
(§4), so a service with no repro harness is not permanently floored at ESCALATE. The sandbox
runs in an ephemeral container with default-deny egress (D7); it clones the repo, replays the
signal, and produces booleans — it holds no repo-write token and touches no prod surface.

Autonomy transition to any *write* behavior is out of scope for Loop A entirely; that is
Loop C's deferred, per-incident-class, mutation-gated, outcome-earned path
(ARCHITECTURE-REFRAMED, decisions D5/D10). Loop A does not "graduate" into Loop C — they are
different loops with different accountability owners (D9).

**Hard prerequisite.** Loop A's outcome-weighted retrieval (§6) and the human-verdict feedback
(§7) both depend on the **outcome watcher** that sets durable outcome labels (recurrence /
revert / recur checks). That watcher is owned by INCIDENT-MEMORY.md, not by Loop A. If it does
not exist, every closed trace stays at `pending` forever, no positive exemplars ever accrue,
and outcome-weighting degrades to neutral retrieval. Loop A ships *with* it, not before it.

---

## 2. Incident Candidate contract

Extends ARCHITECTURE-ORIGINAL §2. New fields carry deploy-correlation state (so the agent's
first heuristic and its anchoring-bias escape hatch are *data*, not prompt guesswork — §3),
grounded-confidence scaffolding (D3), and pre-joined links to similar past incidents (§6).

The dedup/aggregation layer (ARCHITECTURE-ORIGINAL §3) populates everything except the
`rca` block, which Loop A fills in and which starts `null`.

```json
{
  "id": "9f1c2b7a-uuid",
  "schema_version": 2,

  "source": "sentry | otel | rum | business-metric",
  "fingerprint": "sha256:stack-and-location-hash",
  "fingerprint_lineage": ["sha256:prev-fingerprint-before-refactor"],

  "severity_raw": 0.0,
  "priority": 0.0,

  "first_seen": "2026-07-01T09:14:22Z",
  "last_seen": "2026-07-01T09:41:03Z",
  "onset_ts_uncertainty_s": 30,
  "occurrences": 231,

  "affected_service": "checkout-api",
  "affected_paths": ["src/checkout/tax.ts", "src/checkout/cart.ts"],

  "trace_ids": ["4bf92f3577b34da6a3ce929d0e0e4736"],
  "signal_class": "exception | latency | error-rate | saturation | business-metric",
  "shape": "step | slope | spike | unknown",

  "deploy_correlation": {
    "recent_deploys": [
      { "deploy_id": "dpl_88213", "ts": "2026-07-01T09:05:00Z",
        "diff_url": "https://github.com/org/repo/compare/abc..def",
        "sha_range": "abc123..def456",
        "touches_affected_paths": true }
    ],
    "window_minutes": 60,
    "has_recent_deploy_in_window": true,
    "onset_before_last_deploy": false,
    "correlation_state": "deploy_linked | no_recent_deploy | onset_predates_deploy | ambiguous"
  },

  "similar_incidents": [
    { "incident_id": "past-uuid-1", "similarity": 0.91,
      "outcome": "confirmed_good", "resolution_class": "code",
      "memory_ref": "incident_memory/past-uuid-1" }
  ],

  "rca": null,

  "raw_payload": {}
}
```

Field notes:
- `fingerprint_lineage` — the chain of prior fingerprints this candidate maps to across
  refactors. Directly addresses STRESS-TEST §9 "fingerprint drift silently disables Memory
  retrieval." Populated when the dedup layer detects a rename/move via `git log --follow` on
  `affected_paths`; retrieval (§6) searches the whole lineage.
- `onset_ts_uncertainty_s` — resolution of the onset timestamp for this signal
  (metric scrape interval, sampling window, or trace granularity). Feeds the `ambiguous`
  computation below.
- `shape` — the metric's onset shape from the aggregation layer: a discrete `step` (consistent
  with a deploy-caused break) vs a `slope` (gradual leak/saturation, inconsistent with a single
  deploy) vs `spike`/`unknown`. Deterministic from the metric series; used as a §4 grounding
  discriminator for non-exception signals so a coincidental deploy can't be over-attributed.
- `deploy_correlation.correlation_state` — the **branch selector** for §3's tool loop. Computed
  deterministically by the aggregation layer, not by the LLM, by the following exhaustive,
  non-overlapping rules (evaluated top to bottom; first match wins):
  1. `no_recent_deploy` — no deploy in `window_minutes`.
  2. `onset_predates_deploy` — `first_seen` (minus `onset_ts_uncertainty_s`) is strictly before
     the last in-window deploy's `ts`.
  3. `ambiguous` — a deploy is in-window **and** either (a) the onset timestamp uncertainty
     interval `[first_seen − onset_ts_uncertainty_s, first_seen + onset_ts_uncertainty_s]`
     overlaps the deploy `ts` (can't order onset vs deploy), or (b) ≥2 in-window deploys with
     conflicting `touches_affected_paths`, so no single deploy is the clear anchor.
  4. `deploy_linked` — a deploy is in-window, onset is unambiguously after it, and exactly one
     in-window deploy touches the affected paths.
- `similar_incidents` — pre-joined at ingestion so the agent starts with candidates, but
  full outcome-weighted retrieval still happens inside the loop (§6) with the live query.
- `rca` — the null slot Loop A writes into; its shape is §5.

---

## 3. The RCA investigation agent

An investigation agent (Claude Agent SDK, TS-native), not rule-based alerting: it chooses
which tools to run, but the *order* is constrained by a fixed loop skeleton so behavior is
auditable and the deploy-anchoring failure mode (attack #5) is structurally prevented rather
than left to the model's discretion.

### Tool inventory (all read-only)

| Tool | Backing | Notes |
|---|---|---|
| `code.search` | semantic + full-text over indexed repo | find symbols, call sites, error strings |
| `code.read` | read-only FS on a clean clone | read file / range; never write |
| `git.blame` | read-only git | who/what/when last touched a line |
| `git.log` | read-only git | history on path, `--follow` across renames |
| `git.diff` | read-only git | deploy diff for `sha_range`; arbitrary commit compare |
| `deploy.list` | deploy-events feed | deploys in a widened window |
| `trace.correlate` | OTel backend by `trace_id` | trace waterfall, span errors, timing; also the **occurrence-matcher** for G2 |
| `log.correlate` | log store by `trace_id` / fingerprint | **untrusted text — see D7** |
| `memory.retrieve` | Incident Memory (pgvector) | outcome-weighted, §6, INCIDENT-MEMORY.md |
| `repro.sandbox` | ephemeral container, egress-controlled | read-only harness; the strongest grounded boolean (D2/D3), when a harness exists |

`repro.sandbox` for Loop A is a **read-only reproduction harness**: clone at a chosen commit,
replay the signal (a captured request, a failing input, a synthetic load matching the metric),
observe whether the signal reproduces. It produces booleans, not fixes. It has no repo write
token, no prod credentials, and egress is default-deny (D7).

### Tool-loop order (fixed skeleton)

```
0. INGEST candidate. Read deploy_correlation.correlation_state (deterministic, from §2).
   If a repro harness exists for the service, DISPATCH an early hypothesis-free repro in
   parallel (see "on parallelism" below): "does the raw captured signal reproduce at HEAD?"
   This needs no hypothesis, so it can start immediately and overlap steps 1–3; its result
   feeds G1a in step 4.

1. BRANCH on correlation_state:

   case deploy_linked:
     1a. git.diff the correlated sha_range.
     1b. Does any hunk touch affected_paths? record `affected_path_in_deploy_diff`.
     1c. trace.correlate + log.correlate by trace_id to localize the failing span.
     → proceed to 3 with deploy as PRIMARY hypothesis source.
     NOTE: for non-exception signal classes (latency / error-rate slope / saturation /
     business-metric), a deploy in-window may be causally irrelevant even when deploy_linked
     (a coincidental deploy). The §4 gate handles this: G3 alone cannot confirm a
     gradual-degradation signal (see G6, step-vs-slope).

   case no_recent_deploy | onset_predates_deploy | ambiguous:  ← ATTACK #5 GUARD
     1a. DO NOT anchor on the last deploy. Explicitly widen:
         - deploy.list over a widened window (default 7d) AND non-deploy causes:
           config/flag changes, data drift, upstream/dependency latency,
           capacity/saturation, gradual leak (compare metric slope, not step).
         - trace.correlate to find WHERE latency/errors concentrate, independent of deploy.
     1b. Record `search_widened = true` and the causes considered, so the trace shows the
         anchor was actively resisted (not silently skipped).
     → proceed to 3 with NO privileged deploy hypothesis.

2. RETRIEVE similar past incidents (memory.retrieve, §6), outcome-weighted. Confirmed-good
   resolutions become positive exemplars; failures are injected as LABELED anti-patterns
   ("this fix was tried for a similar signal and recurred — do not repeat").

3. FORM hypotheses. Rank primary + alternatives. For EACH hypothesis, enumerate what
   observable would confirm or refute it (this is what §4 turns into gates).

4. GATHER grounding evidence for the top hypothesis. These are MECHANICAL checks, not
   LLM self-assessments (see §4 on how each is computed):
   - G2: trace.correlate — mechanically match sampled trace_ids to the hypothesis's failing
     span/signature; record the matched fraction.
   - G3: is the implicated path in the correlated deploy diff, if deploy_linked?
   - G6 (non-exception signals only): step-vs-slope discriminator from `shape` (§2) — a
     deploy-caused break is a `step` at the deploy ts; a `slope` is inconsistent with a single
     deploy and must not be attributed to it on G3 alone.
   - G1: if the early repro dispatched at step 0 completed, read `signal_reproduced`; if a
     hypothesis-specific repro (e.g. replaying the specific failing input) is cheap and adds
     grounding, dispatch it now.

5. GATE (§4). If grounded booleans clear threshold → emit why-trace with recommended action.
   If not → emit why-trace flagged ESCALATE with the alternatives and the specific
   missing evidence. NEVER fabricate confidence to clear the gate.

6. WRITE trace to Incident Memory (labeled outcome pending human confirmation).
```

**On parallelism (attack #9 latency).** Only the *hypothesis-free* repro at step 0 ("does the
raw signal reproduce at HEAD?") runs in parallel with steps 1–3 — it needs no hypothesis, so it
can overlap. A *hypothesis-specific* repro (step 4) cannot start before step 3, by definition.
The §8 budget is written against this: the early repro hides most of the sandbox cost under the
investigation, but the spec does not claim the *whole* sandbox stage is free of the critical
path.

**Why the branch is load-bearing (attack #5).** Deploy-correlation-first is the correct strong
heuristic for the common case and the reason ARCHITECTURE-ORIGINAL §2 calls deploy events
"critical … first." But silent degradation and business-signal-without-exception incidents —
the most expensive ones — are precisely the incidents *not* correlated to a recent deploy, or
correlated only *coincidentally*. Anchoring on "the last deploy did it" there produces a
confident wrong root cause. Two guards close this: (1) the `correlation_state` branch makes
`no_recent_deploy | onset_predates_deploy | ambiguous` a **first-class path that forbids the
deploy anchor and forces a widened search**, recorded as `search_widened`; (2) even inside
`deploy_linked`, the §4 gate refuses to confirm a **gradual-degradation** signal on
deploy-diff grounding alone (G6), because a `slope` onset is mechanically inconsistent with a
single-deploy step-change. The selector is deterministic (§2), so the model cannot "decide" it
is a clean deploy incident to save work.

---

## 4. Grounded confidence (D3, D8)

Confidence is **a set of observable booleans**, never a self-reported LLM score. Self-reported
LLM confidence is ~uncorrelated with correctness and is systematically inflated
(STRESS-TEST §2). The why-trace records the booleans and their evidence pointers; the gate is a
pure function of the booleans.

**D8 status for Loop A.** Loop A has **no judge agent** — there is no fix to grade, so the
attack-#4 "grades its own homework" problem does not arise in its original form. But D8's
principle (verification independence from *signals*, not a second same-family prompt) still
governs the confidence gate: every boolean below is set by a **deterministic mechanical check
or a tool result**, never by the same LLM asserting its own hypothesis is well-grounded. Where
a check is only *structural* (can be verified mechanically) but not *semantic* (whether the
cited evidence truly supports the claim), it is labeled as such below and **not overclaimed as
an anti-hallucination guarantee**.

### The booleans

```ts
interface GroundedConfidence {
  // G1 — did a controlled reproduction reproduce the signal? (D2/D3)
  //   Set from repro.sandbox tool result, not the model. null when no harness ran;
  //   only `true` counts as grounding. Tool-grounded (semantic).
  signal_reproduced: boolean | null;

  // G2 — does the hypothesis account for ~ALL occurrences, not a convenient subset?
  //   MECHANICAL: trace.correlate samples S trace_ids (config `g2_sample_size`) and matches
  //   each against the hypothesis's failing span/signature. true iff matched_fraction >=
  //   `g2_match_threshold` (config). If the model merely asserts "explains all" without the
  //   mechanical match, G2 is `null`, NOT `true`. Tool-grounded (semantic on the sample).
  explains_all_occurrences: boolean | null;

  // G3 — is the implicated code path actually present in the correlated deploy diff?
  //   MECHANICAL: hunk-overlap between the hypothesis's cited path/range and the deploy diff.
  //   Only meaningful when correlation_state == "deploy_linked". For non-deploy incidents this
  //   is `null` and MUST NOT be treated as passing. Tool-grounded (structural: path is in the
  //   diff; does NOT by itself prove causation — see G6).
  affected_path_in_deploy_diff: boolean | null;

  // G6 — step-vs-slope discriminator for NON-EXCEPTION signals (latency / error-rate /
  //   saturation / business-metric). MECHANICAL from `shape` (§2): true iff the onset is a
  //   `step` coincident (within onset_ts_uncertainty_s) with the implicated deploy ts; false
  //   for a `slope`. `null` (not applicable) for `signal_class == "exception"`. Blocks a
  //   coincidental deploy from confirming a gradual-degradation incident on G3 alone.
  step_change_at_deploy: boolean | null;

  // G7 — trace localization: independent of any deploy, does >= `g7_localization_threshold`
  //   (config) of sampled occurrences pin to a SINGLE span / code location?
  //   MECHANICAL from trace.correlate. This is the grounding path for non-deploy, no-sandbox
  //   incidents (silent degradation) so they are not permanently floored at ESCALATE.
  //   Tool-grounded (semantic on the sample). `null` if not computed.
  occurrences_localized_to_one_span: boolean | null;

  // G4 — STRUCTURAL check only: every claim in the trace carries >= 1 ev_id that resolves to
  //   a real evidence[] entry. Verified deterministically by the emit path (§5), NOT by the
  //   LLM. This proves citations EXIST and RESOLVE; it does NOT prove the evidence semantically
  //   supports the claim. Labeled structural — it is a hallucination *floor*, not a guarantee.
  every_claim_cited: boolean;

  // G5 — STRUCTURAL check: each enumerated alternative has a non-empty `refuted_by` that
  //   resolves to real evidence, or is explicitly left OPEN (which forces ESCALATE if it is a
  //   live competitor to the top hypothesis). Structural: it proves a refutation was recorded
  //   with evidence, not that the refutation is semantically valid.
  alternatives_refuted: boolean;
}
```

### The gate — encoding "escalate, don't guess below threshold"

ARCHITECTURE-ORIGINAL §4's argument: three honest-90% steps chained give ≈0.9³ ≈ 0.42 — below
a coin flip. The lesson is not "raise the score to 0.9"; it is that *ungrounded* confidence
multiplies into garbage and the cheapest place to stop it is triage. We encode this as an **AND
of grounded booleans**, so nothing compounds silently:

```
Let STRUCTURAL = (G4 == true && G5 == true)              // citations resolve; alternatives closed

Let GROUNDED =
      G1 == true                                          // reproduced (any signal class), OR
   || (signal_class == "exception"
         && correlation_state == "deploy_linked"
         && G3 == true)                                   // exception: path in the causal diff, OR
   || (signal_class != "exception"
         && correlation_state == "deploy_linked"
         && G3 == true && G6 == true)                     // non-exception: path in diff AND step-at-deploy, OR
   || G7 == true                                          // occurrences localize to one span (deploy-independent)

CONFIRMED (recommend a specific action, still human-decided):
    STRUCTURAL && G2 == true && GROUNDED

ESCALATE (hand over hypothesis + alternatives + the exact missing boolean):
    otherwise.
```

Rationale, boolean by boolean:
- **No single boolean can carry the gate.** Every `GROUNDED` disjunct is ANDed with `G2` and
  `STRUCTURAL`. This is the AND that keeps 0.9³ from happening: you cannot reach CONFIRMED on
  one lucky factor.
- **G1 (repro) is the strongest** but is `null` when no sandbox harness exists for the service.
  When it is `null`, grounding must come from a deploy path (G3, plus G6 for non-exception
  signals) **or** from deploy-independent localization (G7). This removes the permanent-ESCALATE
  floor the earlier design would have imposed on the silent-degradation class — the exact class
  §3 spends the most effort defending.
- **G2 is mandatory and mechanical.** A hypothesis that explains 200 of 231 occurrences is
  *not* the root cause; the rest are either a second incident or a refutation. G2 is a
  trace-match fraction against a sampled set, not the model asserting "explains all" — if the
  model only asserts it, G2 is `null` and the gate cannot pass. This is the fix for the "G2 is a
  slogan" trap.
- **G3 is structural, not causal.** "The path is in the deploy diff" proves presence, not cause.
  For exceptions that terminate inside the changed code it is strong; for non-exception
  gradual-degradation signals it is **not sufficient alone**, so G6 (step-at-deploy) is ANDed
  in. A coincidental deploy that happens to touch the path cannot confirm a `slope` incident.
- **G3 is `null`, not `true`, for non-deploy incidents** — you cannot borrow deploy-diff
  grounding for an incident with no causal deploy. Closes the attack-#5 back door.
- **G7 gives non-deploy / no-sandbox incidents a real path to CONFIRMED** via mechanical trace
  localization, so the copilot's headline "recommend a specific action" output is *reachable*
  for silent degradation, not structurally impossible.
- **G4/G5 are STRUCTURAL floors, not semantic guarantees.** They are checked deterministically
  by the emit path (every claim resolves to a real `ev_id`; every alternative is closed with
  evidence or left explicitly OPEN). They stop uncited fabrication and dangling alternatives;
  they do **not** verify that a cited span truly supports the claim — that judgment stays with
  the human reading the trace (§7). We label them honestly rather than overclaiming
  anti-hallucination.

Loop A never blocks anything by being uncertain; ESCALATE is a *fully useful* output (the human
gets the ranked hypotheses and the named missing evidence — §7). The gate only governs whether
Loop A says "recommend X" vs "here's what I have, you decide."

```yaml
# gate config (VERIFICATION-GATE.md owns the shared knobs)
grounded_confidence:
  g2_sample_size: 50          # trace_ids sampled for occurrence-match
  g2_match_threshold: 0.95    # matched fraction to set G2 = true
  g7_localization_threshold: 0.90  # fraction pinning to one span to set G7 = true
```

---

## 5. Grounded why-trace output format

The replayable artifact (ARCHITECTURE-ORIGINAL §0.3). One per investigation, immutable once
emitted, stored in Incident Memory. `evidence[]` is the ground truth; every hypothesis claim
and every grounded boolean references evidence by `ev_id`. The emit path (§"Interfaces")
**mechanically verifies** G4 (every claim's `ev_id` resolves) and G5 (every alternative has a
resolving `refuted_by` or is explicitly `open`) before persisting — these are the structural
checks of §4, not model self-report.

```json
{
  "trace_id": "rca-uuid",
  "incident_id": "9f1c2b7a-uuid",
  "schema_version": 1,
  "created_at": "2026-07-01T09:43:10Z",
  "agent_version": "loop-a@1.4.2",
  "model": "claude-...",
  "correlation_state": "deploy_linked",
  "signal_class": "exception",
  "search_widened": false,
  "suspicious_content_flag": false,

  "signal": {
    "summary": "checkout-api 500s on tax calc, 231 occ in 27 min, onset 09:14Z",
    "signal_class": "exception",
    "shape": "step",
    "occurrences": 231,
    "trace_ids": ["4bf92f3577b34da6a3ce929d0e0e4736"]
  },

  "evidence": [
    { "ev_id": "e1", "kind": "deploy_diff",
      "ref": "abc123..def456", "hunk": "src/checkout/tax.ts L40-47",
      "note": "rate lookup changed from Map.get to array.find; returns undefined on miss" },
    { "ev_id": "e2", "kind": "trace_span",
      "ref": "4bf92f...:span-7", "note": "TypeError: cannot read 'rate' of undefined at tax.ts:44" },
    { "ev_id": "e3", "kind": "log_line", "trust": "untrusted",
      "ref": "log:2026-07-01T09:14:22Z", "note": "quoted as data; see D7" },
    { "ev_id": "e4", "kind": "sandbox_repro",
      "ref": "repro-run-51", "result": "reproduced", "note": "replayed captured request, 500 at tax.ts:44" },
    { "ev_id": "e5", "kind": "occurrence_match",
      "ref": "trace.correlate:sample-50", "matched_fraction": 0.98,
      "note": "49/50 sampled trace_ids terminate at tax.ts:44 signature" },
    { "ev_id": "e6", "kind": "past_incident",
      "ref": "incident_memory/past-uuid-1", "outcome": "confirmed_good",
      "note": "March: same undefined-on-miss pattern, fixed by fallback rate" }
  ],

  "hypotheses": [
    { "rank": 1, "statement": "Deploy dpl_88213 replaced Map.get with array.find in tax rate lookup; unmatched region yields undefined → TypeError on .rate",
      "fix_class": "code",
      "estimated_risk_tier": 3,
      "supported_by": ["e1", "e2", "e4", "e5", "e6"] }
  ],
  "alternatives": [
    { "statement": "Upstream tax-rate service returning empty set",
      "status": "refuted", "refuted_by": ["e2"], "refutation": "stack terminates in our code, not an outbound call" },
    { "statement": "Flaky/intermittent (not deploy-caused)",
      "status": "refuted", "refuted_by": ["e4"], "refutation": "deterministic repro on the specific region input" }
  ],

  "grounded_confidence": {
    "signal_reproduced": true,
    "explains_all_occurrences": true,
    "affected_path_in_deploy_diff": true,
    "step_change_at_deploy": null,
    "occurrences_localized_to_one_span": true,
    "every_claim_cited": true,
    "alternatives_refuted": true,
    "gate": "CONFIRMED"
  },

  "recommended_action": {
    "type": "rollback | config_change | code_fix_by_human | investigate_further | escalate",
    "detail": "Roll back dpl_88213 (fastest); durable fix = fallback rate on region miss in tax.ts:44",
    "accountable_owner_on_action": "on-call is the actor; Loop A only advises",
    "blast_radius_note": "checkout tax path only; no data mutation observed"
  },

  "cost": { "tokens": 41200, "wall_ms": 96000, "tools_called": 11 }
}
```

On ESCALATE, `hypotheses` still carries the ranked candidates, `grounded_confidence.gate` is
`"ESCALATE"`, an alternative may carry `"status": "open"` (a live competitor forcing escalation),
and `recommended_action.type` is `"escalate"` with `detail` naming the **specific missing
boolean** ("no sandbox harness for this service → G1 null; deploy-linked but implicated path
not in diff → G3 false; slope onset → G6 false; occurrences not localized → G7 false; need
human to confirm which of hyp-1/hyp-2 holds").

---

## 6. Outcome-weighted retrieval

The `memory.retrieve` tool pulls similar past incidents from Incident Memory (schema and the
outcome watcher in INCIDENT-MEMORY.md). Retrieval is **outcome-weighted** because unfiltered
memory poisons as easily as it teaches: a wrong-but-green past resolution, retrieved as a
positive exemplar, propagates the same wrong hypothesis to every similar future incident
(STRESS-TEST §8).

Query: embed the current signal + hypothesis context; ANN search over Incident Memory's
why-trace embeddings, restricted to `fingerprint_lineage` when available (§2, addresses
fingerprint drift).

Ranking / labeling rules:

```
For each retrieved past incident, read its stored outcome label. Labels are set at closure and
DURABLY UPDATED by the outcome watcher (INCIDENT-MEMORY.md; the D6 signal source). A single
human tap at incident time is NOT sufficient to promote a trace to confirmed_good (see §7):

  outcome == confirmed_good   (human-confirmed cause AND watcher-verified: no recurrence in
                               N days, not reverted, no new incident in the touched file)
      → POSITIVE EXEMPLAR. Boost. Inject as "worked before" context.

  outcome == failed | reverted | recurred | wrong_rca
      → ANTI-PATTERN. Do NOT boost toward its resolution. Inject with an explicit
        negative label: "A similar signal was diagnosed as X and that resolution
        FAILED (recurred/reverted). Treat X as disfavored; explain why this case differs."

  outcome == provisional_human_confirmed   (human tapped "confirmed" but watcher window
                               has not yet elapsed)
      → WEAK context only. Not a positive exemplar; surfaced with a "provisional, unverified"
        label so it cannot silently graduate a tired 3am tap into a trusted exemplar.

  outcome == pending | unknown
      → NEUTRAL context only. Never a positive exemplar (can't confirm it was good).
```

- Positive exemplars can raise a hypothesis's rank but **cannot by themselves clear the §4
  gate** — grounding still requires the live booleans (a past success is not a current repro).
- Anti-patterns are surfaced *to the model as few-shot negatives* and *to the human in the
  payload* (§7) so both the agent and the reviewer see "we tried this and it burned us."
- This is the direct counter to attacks #3 and #8 compounding: as autonomy expands elsewhere,
  memory does not amplify early mistakes because failed resolutions are down-weighted, not
  silently replayed. It only works if the outcome watcher exists — see §1's hard prerequisite.

---

## 7. Human-facing enriched-incident payload

What the on-call engineer sees in Telegram (HITL bot, ARCHITECTURE-ORIGINAL §8). **Compressed
RCA, not raw logs.** Raw logs are one deep-link away; the message is a decision aid, sized to
read on a phone at 3am.

```
🔴 checkout-api — tax calc 500s
231 occ · 27 min · onset 09:14Z · sev high

WHY (confidence: CONFIRMED ✅)
Deploy dpl_88213 (09:05Z) swapped the tax-rate lookup to array.find;
an unmatched region returns undefined → TypeError at tax.ts:44.

GROUNDED CHECKS
  ✅ reproduced in sandbox (replayed the failing request)
  ✅ explains 49/50 sampled occurrences (≥95%)
  ✅ implicated path is in the deploy diff
  ✅ every claim cited · ✅ alternatives closed (structural)

SIMILAR PAST
  ✅ Mar 2026 — same undefined-on-miss pattern → fixed by fallback rate (held, no recurrence)
  ⚠️ anti-pattern: none

⚠️ SUSPICIOUS CONTENT IN LOGS — none detected

RECOMMENDED NEXT STEP
  → Roll back dpl_88213 (fastest mitigation)
  → Durable fix (human): fallback rate on region miss, tax.ts:44
  Blast radius: checkout tax path only · no data mutation seen

[ Open full why-trace ]  [ Mark cause confirmed (provisional) ]  [ Wrong RCA ]
```

- **Confidence booleans, not a number.** The human sees exactly which grounded checks passed,
  so a plausible-but-thin RCA is visibly thin (fewer green checks) instead of hiding behind a
  "0.87." Defends attack #2. The "every claim cited / alternatives closed" line is explicitly
  labeled *(structural)* so the human does not read it as a semantic guarantee (§4, D8).
- **Suspicious-content flag is on the phone message**, not only in the deep-linked trace. The
  place the human actually decides must carry the D7 warning; when `suspicious_content_flag`
  is true the line reads `⚠️ SUSPICIOUS CONTENT IN LOGS — treat this cause with caution; a log
  line contained instruction-like text (quoted in the trace)`. This is the one decision surface,
  so the warning cannot live only where nobody looks at 3am.
- **Similar incidents with outcomes**, positives and labeled anti-patterns (§6).
- **Recommended next step is an action for the human**, never an action Loop A takes.
  On ESCALATE the block becomes ranked hypotheses + the named missing evidence, and the primary
  button is `[ I'll investigate ]`.
- **The verdict buttons write a PROVISIONAL human verdict, not the durable outcome label.**
  `Mark cause confirmed (provisional)` / `Wrong RCA` record the human's immediate judgment on
  the trace and feed the **RCA-accuracy metric** (ARCHITECTURE-ORIGINAL §13). They set
  `provisional_human_confirmed` / `wrong_rca` — **not** `confirmed_good`. Promotion to
  `confirmed_good` (a positive retrieval exemplar, §6) requires the outcome watcher's
  no-recurrence / no-revert confirmation over the D6 window. This is deliberate: a single tired
  3am tap is close to the ambiguous "human override rate" signal D6 rejects — "good" and "nobody
  really checked" produce the identical tap. Only the durable outcome signal graduates a trace.

---

## 8. Latency budget & the "races the human" problem (attack #9)

**Budget.** Signal-deduped → payload delivered:
- p50 target **≤ 90 s**, p95 **≤ 4 min** for the no-sandbox path.
- With `repro.sandbox`: p95 **≤ 8 min**. The step-0 hypothesis-free repro (§3) runs in parallel
  with the investigation, hiding most sandbox cost; a *hypothesis-specific* repro at step 4
  cannot start before hypotheses exist, so the tail is honest, not a "sandbox is free" claim.
- Hard wall-clock budget **10 min**, then emit whatever is grounded so far, flagged
  `partial` / `ESCALATE`. The agent never runs unbounded (token + wall-clock cap, matches the
  Repair-worker discipline in ARCHITECTURE-ORIGINAL §6).

**The race (attack #9).** On an urgent bug a human may rollback in ~3 min while Loop A is still
investigating. That is fine — Loop A does not act, so there is nothing to collide. It must not,
however, spam a resolved incident or waste the human's attention. Delivery is made race-safe by
tying the send to a single durable transition:

- The durable state machine subscribes to incident-state changes (deploy/rollback events,
  ack, manual resolve) for the incident it is working. Delivery is a **compare-and-set** on the
  incident's `notify_state`: the payload is sent iff `notify_state` transitions
  `investigating → notified` atomically in the same durable step. This makes "human resolved
  vs. we sent" a single serialized decision — you cannot double-notify, and you cannot annotate
  a message that was never delivered.
- On a terminal transition (human resolve / rollback) observed **before** the CAS send wins:
  cancel the send; **persist the COMPLETE why-trace** (not a partial), labeled
  `superseded_by_human`, recording what the human actually did. A completed RCA is retained even
  when the human wins the race, so a subsequent re-alert on the same fingerprint is not blind —
  and if the human's action was itself wrong (e.g. rolled back the wrong deploy), the correct
  RCA is still on record.
- On a terminal transition observed **after** the CAS send has committed: edit the Telegram
  message in place to `✅ resolved by <human> (<action>) — RCA below was FYI` and keep the
  deep-link. No second notification.

**This is honest about scope.** Loop A is a *diagnosis copilot*, strongest on the
non-3-minute long tail — incidents where the cause is not obvious and a human would otherwise
spend 20 minutes reading logs. For the trivial-and-urgent case the human wins the race and
Loop A gracefully steps aside. Whether diagnosis or remediation is the real MTTR bottleneck is
the thing D10 says to *measure* before betting further; Loop A instruments both sides (it
timestamps signal→payload and reads incident→resolve deltas), feeding the D10 self-serve
instrument in ARCHITECTURE-REFRAMED.

---

## Attack defenses (summary)

- **#2 undefined confidence** → §4: confidence is grounded booleans, each set by a mechanical
  check or tool result (repro, occurrence-match fraction, path-in-diff, step-vs-slope,
  trace-localization, structural citation/alternative checks); the gate is an AND so no single
  factor carries it; the human sees the checks, not a number (§7).
- **#4 / D8 grades-own-homework** → §4: Loop A has no judge agent (nothing to grade), and every
  confidence boolean is signal-derived, not a second same-family prompt. G4/G5 are labeled
  **structural, not semantic** — a citation/refutation-recorded floor, not an anti-hallucination
  guarantee. G2 is a mechanical trace-match fraction, `null` if merely asserted.
- **#5 deploy anchoring** → §3 deterministic `correlation_state` branch forbids the deploy
  anchor for `no_recent_deploy | onset_predates_deploy | ambiguous`; and inside `deploy_linked`,
  §4's G6 blocks a coincidental deploy from confirming a gradual-degradation (`slope`) signal on
  G3 alone. G3 is `null` (not passing) for non-deploy incidents.
- **#8 / #3 memory poisoning & runaway** → §6 outcome-weighted retrieval: only watcher-verified
  `confirmed_good` are positive exemplars; failures are labeled anti-patterns; a provisional
  3am tap does not graduate a trace (§7). Hard dependency on the INCIDENT-MEMORY.md outcome
  watcher stated in §1.
- **#9 latency / racing the human** → §8: 90 s p50, 10-min hard wall, only the hypothesis-free
  repro parallelized (no over-claim); race-safe CAS delivery, complete trace persisted on
  supersede, never double-notify; positioned as the long-tail diagnosis tool with D10 hooks.
- **Log-borne prompt injection (D7)** → the RCA agent reads logs / stack traces / error
  messages, which are attacker-reachable fields, while holding tools. Mitigations, in scope for
  v1:
  1. **All telemetry text is untrusted data, never instructions.** `log.correlate` /
     `trace.correlate` outputs are wrapped and delimited as quoted data; the system prompt
     states no instruction found inside telemetry text is ever to be followed, and evidence of
     that class is tagged `"trust": "untrusted"` in the trace (see `e3` in §5).
  2. **Loop A has no write tools to hijack.** Even a successful injection reaches only
     read-only code/git/trace/log/memory tools and an egress-controlled read-only sandbox —
     there is no repo-write, deploy, or prod path to steer into (this is *why* Tier 1 / no-write
     is a security property, not just a product choice). Signal ingestion is
     signed/authenticated upstream (D7), so a forged Sentry payload can't even enter the loop.
  3. **Sandbox egress is default-deny.** `repro.sandbox` cannot exfiltrate or call out; a
     payload that tries to make the repro reach the network fails closed and is flagged.
  4. **Injection-shaped content is surfaced, not hidden.** If telemetry text contains
     instruction-like patterns ("ignore previous", tool-call syntax, URLs to fetch), the trace
     sets `suspicious_content_flag = true` and the **compressed human payload** (§7) — not just
     the deep-linked trace — carries the warning, turning an attack attempt into a signal rather
     than a silent steer.

---

## Interfaces (buildable surface)

```ts
// Entry: durable state machine (AgenticOps Postgres, D1) invokes this per deduped candidate.
async function investigate(candidate: IncidentCandidate): Promise<WhyTrace>;

// Read-only tools registered with the Claude Agent SDK runner. No write tool exists in Loop A.
type RcaTool =
  | { name: "code.search";    input: { query: string; kind: "semantic" | "text" } }
  | { name: "code.read";      input: { path: string; range?: [number, number] } }
  | { name: "git.blame";      input: { path: string; range?: [number, number] } }
  | { name: "git.log";        input: { path: string; follow?: boolean; since?: string } }
  | { name: "git.diff";       input: { shaRange: string } }
  | { name: "deploy.list";    input: { service: string; windowMinutes: number } }
  | { name: "trace.correlate";input: { traceId?: string; matchSignature?: string; sample?: number } } // also G2/G7 matcher
  | { name: "log.correlate";  input: { traceId?: string; fingerprint?: string } } // untrusted output
  | { name: "memory.retrieve";input: { signalEmbedding: number[]; lineage?: string[] } }
  | { name: "repro.sandbox";  input: { sha: string; replay: ReplaySpec } }; // read-only, egress-deny

// Gate — pure function, no LLM. Takes the signal class + correlation state as well as the booleans.
function gate(
  c: GroundedConfidence,
  signalClass: SignalClass,
  correlationState: CorrelationState,
): "CONFIRMED" | "ESCALATE";

// Emit path: mechanically verify G4/G5 structural checks against evidence[], persist the trace
// (immutable), then deliver the enriched payload via a compare-and-set on incident notify_state.
async function emit(trace: WhyTrace): Promise<void>;
```

Everything Loop A does is replayable from the stored `evidence[]` + tool-call log; the immutable
audit log and kill switch are the shared cross-cutting machinery (ARCHITECTURE-ORIGINAL §12) —
under kill switch Loop A keeps running (it is diagnosis-only and safe by construction), while the
write-capable loops freeze.
