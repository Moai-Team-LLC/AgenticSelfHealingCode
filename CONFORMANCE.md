# Conformance — Self-Healing Ops × Agentic Product Standard

Mapping of Self-Healing Ops (SHO) onto the [agentic-product-standard](https://github.com/AlexDuchDev/agentic-product-standard) single-agent track (`AGENT_STANDARD.md`). The standard is a standard, not a service — so this is its "adapter": a conformance mapping, not code. Every SHO reference below is a real file in this repo; the architectural source of truth is `ARCHITECTURE-REFRAMED.md` and the D1–D10 ledger in `DECISIONS.md`.

**Terminology collision, up front.** Both documents use "L0–Ln" and both use numbered tiers, for different things:

| Scale | Standard's meaning | SHO's meaning |
|---|---|---|
| L0–L4 (standard) | *Design-time* autonomy of control flow (L0 single call … L4 open loop) | — |
| L0–L3 (SHO) | *Runtime* write-autonomy an incident-class has **earned** (`AutonomyLevel` in `packages/contracts/src/types.ts`) | L0 diagnose-only … L3 auto-apply |
| P0–P6 (standard) | Side-effect danger of a **tool** | — |
| Tier 1–4 (SHO) | Risk/route class of an **action** (`Tier` in `packages/contracts/src/types.ts`; Tier 4 never autonomous) | — |

In the standard's vocabulary SHO is an **L1–L2 system**: a deterministic workflow with exactly one LLM call site. The model owns zero control flow at every SHO autonomy level — even SHO-L3 auto-apply is a deterministic pipeline in which the LLM only proposed text. This document uses "SHO-L*" when the SHO scale is meant.

---

## Doctrine 1 — Determinism First, Agency Second

**Conforms, and is stricter than the letter of the rule.**

- **Least autonomous architecture.** SHO's whole product is `deterministic workflow with LLM steps` on the standard's preference ladder. The single LLM call (hypothesis proposal) is injected and awaited *outside* the deterministic core: `packages/loop-a/src/investigate.ts` is synchronous and pure; the real model lives in `packages/adapters/src/claude.ts` and its output re-enters via `FakeLlmClient(proposal)`. No L4 loop exists anywhere in the repo.
- **Do not climb until earned.** The standard's transition rule is "≥90% pass on a curated eval set." SHO implements a *harder* runtime variant: per-incident-class promotion to auto-apply requires ≥30 confirmed-good **production outcomes** at ≥0.98 rate plus 14-day dwell (SHO-L2), and 100/0.99/45d (SHO-L3) — `DEFAULT_TRUST_CONFIG` in `packages/trust-controller/src/control.ts`. Demotion is immediate on a single caused-incident (`meetsGate` clean-window check). Autonomy is earned on outcomes, never granted in advance — which is the doctrine's intent. What SHO lacks is the *eval-set* leg of that rule (see GAPS #1, #2).
- **"L4 is the last resort" taken literally.** The only candidate for open-ended autonomy — production-code repair — is demoted to a deferred tail (`LOOP-C-DEFERRED.md`), never architected first (D5, D10 in `DECISIONS.md`).
- **Composition patterns.** Routing: `packages/orchestrator/src/router.ts` (class → gate tuple) and the Loop B A/B/C/D discriminator (`packages/loop-b/src/discriminator.ts`). Evaluator-optimizer: present in inverted, non-looping form — the generator (LLM proposal) is paired with a **non-LLM critic** (the verification gate, `gate/verify.ts`), but a rejection goes to a human, never back into a re-prompt loop. That is deliberate (no hidden repair loop), not an omission.

## Doctrine 2 — Harness Over Model

**Conforms.** The standard's "~98% of the code is harness" is nearly literal here: one LLM call site (`packages/adapters/src/claude.ts`), everything else deterministic TypeScript. Mapping to the seven harness layers:

| Standard layer | SHO mechanism |
|---|---|
| 1. Agent loop (gather → act → verify) | `packages/app/src/runtime.ts` (signal → dedup → RCA → deliver) + `packages/pipeline/src/index.ts` glue; full walk in `packages/pipeline/pipeline.test.ts` (signal → dedup → RCA → route → gate → apply → trust → kill) |
| 2. Context & memory | `packages/incident-memory/` — pgvector store (`postgres.ts`), similarity retrieval (`similarity.ts`), **outcome-weighted polarity** (`polarity.ts`: only `confirmed_good` is a positive exemplar; failures retrieved as labeled anti-patterns, never neutral matches) |
| 3. Durable execution | `packages/orchestrator/` — incident state machine + `notify_state` CAS (`statemachine.ts`), Postgres stores (`postgres.ts`, live-verified by `verify-orch-pg.ts`), idempotent apply-time writer (`autoaction.ts`; `UNIQUE (incident_id, fix_sha)` in `packages/contracts/src/sql.ts`) |
| 4. Guardrails | Input: HMAC verify-before-normalize (`packages/signal-layer/src/verify.ts`), hand-rolled untrusted-payload validators + injection flagging (`packages/contracts/src/guards.ts`). Output: the non-LLM signal battery (`gate/verify.ts` composing `verification-gate/` must-fail-on-parent + `mutation-gate/` mutation score + no-weakening) |
| 5. Human-in-the-loop | `packages/hitl/` — async approval ladder (`ladder.ts`), business-hours downgrade of any auto-apply (`businesshours.ts`), signed kill-switch release (`killrelease.ts`), notifier port (`notifier.ts`) with real Telegram adapter (`packages/adapters/src/telegram.ts`) |
| 6. Evaluation | Per-package `bun test` suites (every package has a co-located `*.test.ts`); the verification gate is itself a per-change CI-shaped gate. No curated eval corpus yet (GAPS #1) |
| 7. Observability & tracing | `WhyTrace` (grounded, replayable — `packages/contracts/src/types.ts`), `GateResult` frozen as JSONB on every landing (`sql.ts`), `TelemetrySink` port (`packages/contracts/src/ports.ts`). No OTel yet (GAPS #5) |

"Never rely on a prompt to enforce security, permissions, or control flow" — SHO holds this absolutely: there is no load-bearing prompt anywhere; permissions, tiers, kill switch, and gates are all code.

## Doctrine 3 — Context Engineering Over Prompt Engineering

**Mostly conforms.**

- **Write:** durable state lives outside the model — incident memory (`packages/incident-memory/src/memory.ts`), orchestrator Postgres state, the `auto_action` ledger.
- **Select:** the model receives a curated `evidenceSummary` plus similarity-retrieved past incidents with polarity labels — never raw logs, never raw transcripts (`packages/loop-a/src/tools.ts`, `packages/incident-memory/src/polarity.ts`).
- **Closed enumerations over open vocabularies:** SHO is strict here — `OutcomeLabel`, `OutcomeEventKind`, `BrokenClass`, `SignalSource`, `SignalShape`, `Tier`, `AutonomyLevel` are all closed unions in `packages/contracts/src/types.ts`, enforced at the untrusted boundary by `packages/contracts/src/guards.ts`. Nothing re-declares them (the `@sho/contracts` spine exists precisely to prevent divergent shapes).
- **Isolate:** trivially satisfied — one LLM call, one context.
- **The 40% rule:** not measured. The evidence summary is curated but unbudgeted; no token accounting exists (GAPS #12).

## Doctrine 4 — Cycle of Trust

**Conforms.** The standard's cycle maps 1:1 onto SHO's pipeline:

| Standard step | SHO mechanism |
|---|---|
| gather context | signal layer + aggregation (`packages/signal-layer/src/ingest.ts`, `packages/aggregation/`) |
| propose action | Loop A why-trace / Loop B heal / Loop C fix (proposal only) |
| check permissions | router reads the class's earned level + D9 owner (`packages/orchestrator/src/router.ts`); kill bit forces L0 (`killswitch.ts`); crosswalk is single-sourced (`packages/contracts/src/crosswalk.ts`) |
| verify preconditions | verification gate signal battery (`gate/verify.ts`) — must-fail-on-parent, mutation score, no-weakening |
| execute | apply-time writer (`packages/orchestrator/src/autoaction.ts`) — the only component that records a landing |
| verify outcome | outcome watch: recurrence / spawn / revert detection over `WINDOWS_DAYS` (`packages/contracts/src/types.ts`), projected as `OutcomeEvent`s |
| write trace | immutable why-trace + `gate_result` JSONB frozen per landing |
| update memory | outcome labels drive retrieval polarity (`polarity.ts`) |

"Permissions enforced in code, never in the prompt" — the Replit-incident lesson is a design axiom here (D7): the model cannot toggle the kill switch (release requires the signed on-call chain in `packages/hitl/src/killrelease.ts`: authn → MFA → detached signature bound to `killed_at` → single-use nonce → dual attribution), cannot select tools (deterministic code runs tools and hands the model evidence — the inversion of the usual tool-calling risk), and Loop A structurally cannot write (below). One hole: protected-path enforcement is spec-only (GAPS #9).

## Doctrine 5 — Eval-Driven Development

**Conforms in mechanism, gapped in corpus.**

- **The standard's deepest requirement — don't trust self-report — is SHO's founding decision.** Confidence is a set of observable booleans set by mechanical checks (`GroundedConfidence` in `types.ts`; derivation in `packages/loop-a/src/confidence.ts`), never an LLM number (D3; the 0.9³ ≈ 0.42 argument in `ARCHITECTURE-REFRAMED.md` §0).
- **Code assertions for deterministic requirements:** every package has a test suite; the strongest instance is the **must-fail-on-parent** anchor (`verification-gate/gate.ts`) — every machine-authored heal/fix must carry a test that fails on the parent commit for a behavior reason and passes on the fix. That is the standard's "hard-to-vary acceptance criterion" mechanized per change.
- **Anti-criteria:** present. `packages/loop-a/loop-a.test.ts` ("package exposes NO write/exec tool") is a code assertion that fails if the forbidden thing (a Loop A write capability) appears — exactly the standard's derived-anti-criterion pattern. Coverage of *all* forbidden actions is incomplete (GAPS #10).
- **LLM-as-judge:** none used — conformant with Non-Negotiable Rule 11 (code assertions suffice). The specced judge (`VERIFICATION-GATE.md` S9) is advisory-only by design and unimplemented; no calibration obligation is triggered.
- **Missing:** the golden/failure-modes/regression eval-set structure, and error-analysis-first on real traces — SHO is pre-production, so no traces exist yet, but the directories and the CI wiring don't either (GAPS #1).

## Doctrine 6 — Bitter-Pilled Maintenance

**Conforms.** SHO has almost no fragile surface to shrink: no chain-of-thought orchestrators, no output-format parsers on critical paths (the Claude adapter parses defensively into a typed `LlmProposal` with a safe fallback, never a throw), no retry cascades, no prompt-encoded process. The anti-fragile assets the doctrine says to keep — verification harness, tool contracts, accumulated failure gotchas — are the repo's center of mass. `DECISIONS.md` (D1–D10) plus `STRESS-TEST.md` form a conjecture→refutation ledger at the architecture level: each decision names the attack that refuted the original design and the corrected mechanism. The per-regression four-field learning trail is not yet a formalized practice (GAPS #13).

## Doctrine 7 — Security Is Structural

**Conforms; this is SHO's strongest axis.**

- **Lethal trifecta: one leg broken by construction.** Loop A — the most-exposed component — reads private repo/telemetry data *and* attacker-reachable untrusted content, but holds **zero write/exec/egress tools**: `packages/loop-a/src/tools.ts` exports read-only tools only, and the anti-criterion test in `loop-a.test.ts` fails the build if a write-shaped export ever appears. A fully successful log-borne prompt injection has nothing to weaponize (D7; `SECURITY-THREATMODEL.md` §3.3).
- **Untrusted input quarantine:** HMAC-SHA256 verified against the raw body *before* parsing, constant-time compare, fail-closed (`packages/signal-layer/src/verify.ts`); instruction-like telemetry text is flagged (`looksLikeInjection` in `guards.ts`) and surfaced as `suspiciousContentFlag` on the why-trace — data, never a command. Indirect injection is explicitly in the threat model, not just user-turn injection.
- **Kill switch fails safe:** absence of a healthy heartbeat = KILLED (`packages/orchestrator/src/killswitch.ts`); anyone can engage; only the signed on-call chain can release; a DoS of the switch degrades to diagnosis-only — the safe direction.
- **MCP supply chain:** N/A — SHO exposes no MCP surface and loads no community tool definitions; all integrations are in-repo adapters behind injected transports (`INTEGRATIONS.md`, `packages/adapters/`).
- **Gaps:** per-loop least-privilege identities, sandbox egress-deny, and the hash-chained audit log are specced (`SECURITY-THREATMODEL.md`) but not implemented (GAPS #6, #8, #11).

---

## Sub-skill mapping (artifacts the standard requires)

### Agent Contract (Sub-skill 1)

Substantially present, wrong format. Each loop has a spec that covers the 13 contract sections in substance — mission, ownership, non-ownership ("Loop A never writes: no change" is even a code comment in `types.ts`), tools, forbidden actions, escalation, logging: `LOOP-A-SPEC.md`, `LOOP-B-SPEC.md`, `LOOP-C-DEFERRED.md`. Output schemas are real types (`WhyTrace`, `LoopBDecision`, `GateResult`). Not rendered in the standard's `contract.md` template; anti-criteria don't yet cover every forbidden action (GAPS #10).

### Implementation architecture (Sub-skill 2)

The required runtime flow (validate input → scoped context → durable state → deterministic steps → LLM only where needed → validate output → assertions → trace) is the literal shape of `packages/app/src/runtime.ts`. Structured outputs everywhere; prompts are code (versioned in `claude.ts`); the model never selects tools and never bypasses permissions — it is never *offered* either capability.

### Multi-agent (Sub-skill 3)

**N/A by design, which is conformance.** SHO is single-agent-plus-workflow; the standard says not to build multi-agent before that baseline exists. One final owner of the user-facing result: the on-call human, via the HITL channel. The `WorkItem`/`BacklogPort` envelope (`ports.ts`) is the structured hand-off surface if platform adapters (AgenticOps) are attached.

### Tools & permissions (Sub-skill 5)

Crosswalk of the standard's P-tiers onto SHO's action tiers:

| Standard P-tier | SHO equivalent | Enforcement |
|---|---|---|
| P0 read | Tier 1 / Loop A (all tools read-only) | structural — no write tool exists; anti-criterion test |
| P1 draft | Loop B heal / Loop C fix as PR (SHO-L1: propose, human merges) | router + crosswalk; `applied_by='human_approved'` |
| P2 internal write | Loop B flaky quarantine — the one autonomous merge, test-tag-only | bounded server-side (`SECURITY-THREATMODEL.md` §5.1) |
| P3 external write | Loop C auto-apply (deferred; earned per-class) | proven-reversible + business-hours + named owner (D9), all preconditions in `ARCHITECTURE-REFRAMED.md` §3.4 |
| P5 communication | HITL notifier (the approval channel itself) | durable `approval_request` row is source of truth; message is a view |
| P6 destructive | Tier 4 (migrations/auth/billing/infra/secrets) | **never autonomous; timed-out Tier-4 approvals AUTO-REJECT** (`packages/hitl/src/ladder.ts`) — stricter than the standard's "always yes" |

Tool count ≪ 20; allowlist is the module's export surface, checked by test. Approval gates for P3+ exist as the ladder; D9 makes a *named human owner* a precondition for any auto-apply — a requirement the standard doesn't even ask for.

### Reliability, durable execution, HITL (Sub-skill 6)

- **Workflow/Activity split & pure state:** the ladder and business-hours gate are pure step functions over `(state, nowMs)` (`ladder.ts`, `businesshours.ts`); the incident lifecycle is an explicit transition table with a CAS (`statemachine.ts`) — the standard's `(state, event) → new_state` demand, met.
- **Idempotency:** apply-time writer keyed on `(incident_id, fix_sha)`; `BacklogPort.enqueue` idempotent on id; `OutcomeEvent` projection idempotent on `actionId`.
- **HITL modes:** notify = Loop A why-trace delivery (`packages/loop-a/src/deliver.ts` + `hitl/notifier.ts`); ask/review = the approval ladder with per-tier semantics (Tier 3 never auto-decides, keeps finding a human; Tier 4 auto-rejects). "Interrupt between tool selection and invocation" = the gate → approval → apply-time-writer sequence: nothing lands without clearing both. The business-hours gate (any auto-apply outside staffed hours downgrades to a PR) exceeds the standard.
- **Missing:** retry/backoff and timeouts at external boundaries; no per-run cost ceiling (GAPS #3, #4).

### Evals & observability (Sub-skill 7)

Trace substance exists — grounded `WhyTrace`, frozen `GateResult` per landing, trust-transition reasons (`control.ts` returns human-readable promotion/demotion justifications), and the `TelemetrySink` port with exactly the event kinds the harm metric needs (`harm | trust_transition | gate_result | rca_outcome | mttr_split | llm_cost`). The **harm metric** — incidents *caused* by machine changes — is first-class (`harmCount` in `control.ts`; `ARCHITECTURE-REFRAMED.md` §9), which is the standard's "product-specific failure modes first" done right. Missing: OTel instrumentation and a 100%-of-runs tracing guarantee (GAPS #5).

### Production readiness (Sub-skill 8) & the D10 discipline

The standard demands evidence before autonomy; SHO adds evidence before *building*: the D10 instrument (`d10-instrument/d10.ts`, fixtures in `d10-instrument/fixtures/`, pull connectors in `connectors/`) measures whether diagnosis or remediation is the MTTR bottleneck before Loop A is committed to over Loop C. Tenant-isolation checklist: N/A (single-tenant OSS deployment); becomes mandatory if SHO is ever hosted multi-tenant.

---

## GAPS — where SHO does not yet meet the standard

Honest list. "Spec-only" means designed in a repo document with no code artifact.

| # | Standard requirement | SHO status | Concrete missing piece |
|---|---|---|---|
| 1 | Eval set per agent (`/golden`, `/failure-modes`, `/regression`) + error-analysis-first on 20–50 real traces | Per-package `bun test` suites only; pre-production, no real traces yet | An `evals/` tree per loop with golden + failure-mode fixtures wired as a CI gate; schedule the 20–50-trace error analysis after first deployment |
| 2 | ≥90% eval-pass rate before climbing an autonomy level | Promotion is outcome-based only (`packages/trust-controller/src/control.ts`) — stricter at runtime, but no eval-set condition on *enabling* a class at all | Add eval-set pass-rate as an AND-term in `meetsGate` / the router's class-eligibility check |
| 3 | Retry with backoff, timeouts at every external boundary | None in the repo (no retry/backoff code anywhere); Telegram send is fire-and-forget with durable-row re-render (partial mitigation); Claude call has no timeout | Retry/timeout wrapper at the `FetchLike` seam in `packages/adapters/src/env.ts` |
| 4 | Per-run token/cost ceiling enforced in code; cost-per-task tracked | `llm_cost` exists as a `TelemetryEvent` kind (`ports.ts`) but is never emitted; no ceiling | Budget check around `deps.propose` in `packages/app/src/runtime.ts`; emit `llm_cost` per incident |
| 5 | Instrument via OTel/OpenInference; 100% of runs traced | `TelemetrySink` port with `InMemoryTelemetry` default only | OTel adapter behind `TelemetrySink` (already planned as the APL/AgenticOps seam in `INTEGRATIONS.md`) |
| 6 | Everything auditable (the standard's trace + the repo's own bar) | Immutable hash-chained, externally-anchored audit log is spec-only (`SECURITY-THREATMODEL.md` §7.2) | Append-only audit store with hash chaining; every enforcement point (gate, router, kill switch, ladder) writes to it |
| 7 | Guardrails complete on the write path | Churn escalator + circuit breaker are spec-only (`TRUST-CONTROLLER.md` §4.1); the gate already reports `diffLines`/`exceedsClassBudget`/`moduleArea` (`gate/verify.ts`) but no controller code consumes them | Extend `packages/trust-controller/src/fold.ts`/`control.ts` to consume the churn signals and cap cumulative same-area churn |
| 8 | Sandboxed execution for risky tool use | Sandbox is an injected interface with a fake (`repro.sandbox` in `packages/loop-a/src/tools.ts`); no real ephemeral sandbox, egress-deny, or least-priv SA | Real sandbox runner; a hard prerequisite for grounded G1 repro in production and for any Loop C earn-path |
| 9 | Permission boundaries enforced below the model, everywhere | Protected paths (`src/auth/**`, migrations, CI config…) are listed in `ARCHITECTURE-REFRAMED.md` §3.4 YAML; the server-side CI path-guard (`SECURITY-THREATMODEL.md` §5.2) has no code artifact | A required CI check that diffs any machine-authored PR against the protected globs and hard-fails |
| 10 | Agent Contract in the 13-section template; an anti-criterion per forbidden action | Specs cover the substance; one strong anti-criterion exists (`packages/loop-a/loop-a.test.ts` no-write-tool test) | Per-loop `contract.md` in the template; derive anti-criteria for the remaining forbidden actions (e.g. assert Loop B's write scope never leaves test paths) |
| 11 | Distinct least-privilege identity per agent | Single-process; per-loop service accounts are spec-only | Separate credentials per loop when deployed as services |
| 12 | ~40% context-window utilization, measured | Evidence summary is curated but unbudgeted; no token accounting | Token accounting + truncation policy on the propose call |
| 13 | Four-field learning trail on every regression entry | `DECISIONS.md` + `STRESS-TEST.md` record conjecture→refutation at the architecture level; no per-regression format | Adopt the `conjectured / refuted by / learned / criterion now` format for post-production regression entries (pairs with GAPS #1) |

---

## Verdict

SHO conforms to the standard's doctrine and in several places exceeds it: autonomy earned on measured production outcomes rather than eval pass-rates alone; a fail-safe kill switch whose *absence of heartbeat* means frozen; Tier-4 approvals that auto-reject on timeout; a named human accountability owner as a code-enforced precondition for any auto-apply; and a harm metric ("incidents caused by machine changes") as the primary safety number. The model owns no control flow, no tool selection, no permission, and no confidence number — the harness is the product, which is the standard's final mental model taken at face value.

The non-conformances cluster in one ring: **operational maturity around the core** — eval corpus and CI gates (GAPS #1–2), retries/timeouts/cost ceilings (#3–4), OTel and the audit-log implementation (#5–6), and the specced-but-unbuilt enforcement pieces (#7–9). None require redesign; each is an additive artifact with a named location above.
