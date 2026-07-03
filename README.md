# AgenticSelfHealingCode

**Self-healing ops for agentic products** — a network of agents for production monitoring,
incident diagnosis, auto-repair, and test-suite healing, **designed adversarially, then reduced
to the parts that are actually safe to build first.**

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![CI](https://github.com/Moai-Team-LLC/AgenticSelfHealingCode/actions/workflows/ci.yml/badge.svg)](https://github.com/Moai-Team-LLC/AgenticSelfHealingCode/actions/workflows/ci.yml)
[![Implements: Agentic Product Standard](https://img.shields.io/badge/implements-Agentic%20Product%20Standard-CD7722.svg)](https://github.com/Moai-Team-LLC/agentic-product-standard)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-black.svg)](https://bun.sh)
[![DB: Postgres + pgvector](https://img.shields.io/badge/db-Postgres%20%2B%20pgvector-336791.svg)](https://github.com/pgvector/pgvector)

Runs **standalone** on Postgres + pgvector — and plugs into the AgenticProduct ecosystem when its
siblings are present (optional adapters, never hard dependencies — see
[`INTEGRATIONS.md`](INTEGRATIONS.md) and [`CONFORMANCE.md`](CONFORMANCE.md)).

## 🚀 Quick start (60 seconds)

Requires only [Bun](https://bun.sh). No keys, no database, no config:

```bash
git clone https://github.com/Moai-Team-LLC/AgenticSelfHealingCode.git
cd AgenticSelfHealingCode
bun run demo
```

The demo starts the real signal-intake service and plays five scenarios at it over real HTTP with
real HMAC signatures. You'll watch it: ground a deploy-linked exception and recommend the rollback
(**CONFIRMED**); refuse to blame a deploy that isn't there and escalate with the **named missing
evidence** (it never guesses); reject a spoofed webhook at the signed-ingestion boundary; flag a
prompt-injection attempt inside telemetry as *data, never instructions*; and decline to double-page
the on-call for a duplicate incident.

### Run it for real

```bash
SIGNAL_SECRET=$(openssl rand -hex 16) docker compose up    # Postgres + pgvector + the service, migrated
SIGNAL_SECRET=<same> bun run send-signal                   # fire a signed signal at it
```

Durable state (incident memory, notify CAS, kill switch, auto-action ledger) now lives in Postgres
and survives restarts. Using your own Postgres instead: set `DATABASE_URL`, run `bun run migrate`,
then `bun run start`.

### → Use it for real

Point your **Sentry** at `/webhook/sentry` (native — no shim), turn on **grounded diagnosis** with a
local repo checkout (`RCA_GIT_REPO`) and Claude (`ANTHROPIC_API_KEY`), deliver to **Telegram** with
tap-to-ack, and operate it over HTTP (`GET /status`, `GET /incidents`, signed `POST /kill|/release`).
The full day-2 walkthrough — connect telemetry → ground RCA → operate — is [`USAGE.md`](USAGE.md).

Every capability is an opt-in env var; the service runs without any of them (on fakes). Copy
`connectors/.env.example` → `connectors/.env` and fill in what you want.

```bash
bun test packages    # the whole product's test suite
```

This repo is two things: a **reconciled design** (the root markdown docs, adversarially reviewed —
start with `ARCHITECTURE-REFRAMED.md`) and a **working product** — the `@sho/*` packages that compose
into a runnable service, verified against real Postgres + pgvector.

## 🌐 Ecosystem

AgenticSelfHealingCode is the **operations-recovery member** of the AgenticProduct family — the
open standard plus its reference implementations:

|     | Repo                                                                                              | Role — use it when                                                                                     |
| --- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 📐  | [agentic-product-standard](https://github.com/Moai-Team-LLC/agentic-product-standard)              | **The standard** — autonomy ladder, composition patterns, the harness layers, eval discipline. Start here. |
| 🧠  | [AgenticMind](https://github.com/Moai-Team-LLC/AgenticMind)                                         | **Knowledge & memory** — citation-enforced answers, replayable why-trace, judge-gated learning over MCP. |
| 🚦  | [AgenticOps](https://github.com/Moai-Team-LLC/AgenticOps)                                           | **Fleet operations** — manifests, backlog, scheduler, telemetry, policy for running agent fleets.        |
| 📊  | Agent Performance Layer (APL)                                                                       | **Observability & evals** — OTel-based traces, golden-set evals, failure clusters. Public release in progress. |
| 🩺  | **AgenticSelfHealingCode** (this repo)                                                              | **Self-healing ops** — incident diagnosis (RCA copilot), test-suite healing, outcome-earned autonomy, verification gates. |

How this repo composes with each sibling — including the ports/adapters already built — is specified
in [`INTEGRATIONS.md`](INTEGRATIONS.md); conformance to the standard is mapped in
[`CONFORMANCE.md`](CONFORMANCE.md).

## The one-line reframe

The original target was autonomous production-code repair. An adversarial stress test
([`STRESS-TEST.md`](STRESS-TEST.md)) showed that's the smallest, riskiest slice, so the center of
gravity moved to **diagnosis (Loop A) + test-suite self-healing (Loop B)**, with autonomous repair
(Loop C) **deferred and earned per-incident-class on outcome data**. Confidence is grounded booleans,
not LLM self-report; trust expands on outcomes, not the absence of vetoes. Full rationale in
[`ARCHITECTURE-REFRAMED.md`](ARCHITECTURE-REFRAMED.md) (the source of truth) and
[`DECISIONS.md`](DECISIONS.md) (D1–D10).

## Design docs

| Doc | Role |
|---|---|
| [ARCHITECTURE-REFRAMED.md](ARCHITECTURE-REFRAMED.md) | 🔑 source of truth — topology, tiers, contracts, metrics |
| [ARCHITECTURE-ORIGINAL.md](ARCHITECTURE-ORIGINAL.md) · [STRESS-TEST.md](STRESS-TEST.md) | the original target + the adversarial review that reshaped it |
| [DECISIONS.md](DECISIONS.md) · [BUILD-PLAN.md](BUILD-PLAN.md) · [COHERENCE-REVIEW.md](COHERENCE-REVIEW.md) | D1–D10, phased rollout, cross-spec reconciliation |
| Component specs | [LOOP-A](LOOP-A-SPEC.md) · [LOOP-B](LOOP-B-SPEC.md) · [LOOP-C-DEFERRED](LOOP-C-DEFERRED.md) · [VERIFICATION-GATE](VERIFICATION-GATE.md) · [INCIDENT-MEMORY](INCIDENT-MEMORY.md) · [TRUST-CONTROLLER](TRUST-CONTROLLER.md) · [ORCHESTRATION](ORCHESTRATION.md) · [HITL-APPROVAL](HITL-APPROVAL.md) · [SECURITY-THREATMODEL](SECURITY-THREATMODEL.md) · [D10-INSTRUMENT](D10-INSTRUMENT.md) |

## Product — `packages/` (Bun-workspace monorepo, TS strict, zero runtime deps)

The real system, built contracts-first so no component re-derives a divergent shape. Every package is
pure, unit-tested decision logic; infrastructure (Postgres, LLM, Telegram) sits **behind interfaces
with in-memory fakes**, so the whole thing is testable now and real adapters drop in later.

| Package | What it owns | Tests |
|---|---|---|
| [`@sho/contracts`](packages/contracts/) | The shared spine: types, L↔tier crosswalk, canonical SQL DDL, untrusted-input guards (D7). | 7 |
| [`@sho/trust-controller`](packages/trust-controller/) | Outcome-fold + the asymmetric autonomy law that closes the D6 runaway (promote on confirmed-good, fast-demote on harm, kill→L0). | 9 |
| [`@sho/incident-memory`](packages/incident-memory/) | Why-trace store, outcome-weighted retrieval (anti-poisoning), `OutcomeEvent` projector, drift-resistant recurrence. | 20 |
| [`@sho/aggregation`](packages/aggregation/) | Fingerprint / rename-proof symptom-signature / dedup / priority. | 18 |
| [`@sho/signal-layer`](packages/signal-layer/) | Signed ingestion (HMAC) + untrusted-input normalization. | 13 |
| [`@sho/orchestrator`](packages/orchestrator/) | Durable state machine, router, apply-time writer (idempotent, both landing variants), single kill bit. | 7 |
| [`@sho/loop-a`](packages/loop-a/) | RCA copilot: grounded-boolean confidence, deploy-anchoring branch, why-trace. **Zero write access.** | 25 |
| [`@sho/loop-b`](packages/loop-b/) | Test-suite self-healing: the A/B/C/D discriminator + flaky quarantine. | 16 |
| [`@sho/hitl`](packages/hitl/) | Async approval ladder + the business-hours gate that closes attack #6. | 25 |
| [`@sho/pipeline`](packages/pipeline/) | **End-to-end vertical slice** — one incident through every package (signal→dedup→RCA→route→gate→apply→trust→kill). | 1 |
| [`@sho/adapters`](packages/adapters/) | Real edges behind interfaces: `TelegramNotifier` + `ClaudeLlmClient` (injected-fetch, tested offline; keys via env). | 5 |
| [`@sho/app`](packages/app/) | The deployable service: signed webhook → pipeline → delivery. Real adapters when keys present, fakes otherwise. | 6 |

```bash
bun test packages                       # the whole product — 152 tests
bun run packages/app/src/server.ts      # start the signal-intake service (fakes until keys are in .env)
```

## Reference kernels (the verified building blocks the packages productionize)

| Kernel | What it proves | Tests |
|---|---|---|
| [`d10-instrument/`](d10-instrument/) | MTTR bottleneck (diagnosis vs remediation). Adapters: CSV, PagerDuty, **Linear**, Sentry, enrich. | 18 |
| [`verification-gate/`](verification-gate/) · [`mutation-gate/`](mutation-gate/) · [`gate/`](gate/) | must-fail-on-parent + mutation score + integrated `verify()` + CLI + PR workflow. | 23 |
| [`loop-b/`](loop-b/) | The discriminator kernel (ported into `@sho/loop-b`). | 10 |
| [`connectors/`](connectors/) | Live Linear/Sentry pull (reads gitignored `.env`) → feeds D10. | — |

Drivers are references (string mutation, git-worktree overlay); the decision layers are
production-shaped and swap onto real engines (StrykerJS, your CI, your tracker) unchanged.

## Quick start

```bash
# run any package's tests + live demo
cd verification-gate && bun test && bun run demo.ts
cd mutation-gate     && bun test && bun run demo.ts
cd loop-b            && bun test && bun run demo.ts
cd gate              && bun test && bun run demo.ts

# D10 on sample data
bun run d10-instrument/d10.ts d10-instrument/fixtures/incidents.sample.json

# the verification gate as a PR check (see .github/workflows/verification-gate.yml)
bun run gate/cli.ts --base <baseSHA> --head <headSHA> --min-mutation-score 0.75

# D10 on YOUR Linear data (after you add a key — see connectors/README.md)
cp connectors/.env.example connectors/.env   # fill LINEAR_API_KEY + LINEAR_STATE_*
bun run connectors/linear-pull.ts
```

## Open-source / secrets boundary

Credentials live **only** in `connectors/.env` (gitignored); the repo ships `.env.example` + the pure
mappers. Pulled data (`incidents.json`, `*.pulled.json`) is gitignored — it can contain
company-identifying content. Before pushing, verify `git status` shows no `.env` and no pulled data,
and rotate any key pasted outside `.env`. Details: [`connectors/README.md`](connectors/README.md).

## Status (what's real vs what needs live infra)

- **Built & verified (203 tests, 0 failures):** all 12 product packages + the reference kernels. The
  component graph composes (the `@sho/pipeline` vertical slice walks a real incident end-to-end), the
  service is runnable (`@sho/app`), and the real **Telegram + Claude adapters are offline-verified**
  (injected-fetch tests — no keys, no network).
- **Postgres + pgvector: fully verified against a real DB.** The contract `MIGRATIONS` build on
  Postgres 16 + pgvector, the freeze trigger fires, and the entire `PostgresIncidentMemory` path —
  `projectOutcomeEvents`, `detectRecurrence`, `harmQuery`, the vector cosine query, and outcome-weighted
  `retrieveSimilar` (via the `retrieve_outcome_weighted` SQL function) — passes
  (`packages/incident-memory/verify-pg.ts`, **18 live checks**). And the **app persists end-to-end to
  real Postgres**: a signed webhook → the HTTP handler → a row in `incident_memory.incidents`
  (`packages/app/verify-app-pg.ts`). The live run caught and fixed three bugs the in-memory tests
  couldn't: a migration-ordering error, a non-portable array bind, and the missing retrieval function.
  Reproduce: `docker run -d -e POSTGRES_PASSWORD=sho -e POSTGRES_DB=sho -p 54329:5432
  pgvector/pgvector:pg16`, apply the migrations via psql, then run the two verify scripts with
  `DATABASE_URL` set. `server.ts` uses Postgres automatically when `DATABASE_URL` is present.
- **Durable orchestrator: Postgres-backed, verified, and wired into the app.** The kill bit
  (`orch.kill_switch`), the `notify_state` CAS, and the `auto_action` ledger all persist and **survive
  process restarts** — a fresh store instance reads exactly where the last left off
  (`packages/orchestrator/verify-orch-pg.ts`, 13 live checks). And the running service uses the durable
  notify: with `DATABASE_URL` set, a signed webhook delivers once, and a **second process (a restart)
  does not re-deliver** the same incident (`packages/app/verify-app-pg.ts`). Adapter writes are now
  awaitable so the incident row lands before the CAS reads it. In-memory versions remain the unit-test fakes.
- **Still open:** the LLM/Telegram adapters just need their (rotated) keys in `connectors/.env` — the
  code is done and offline-tested. That is the only remaining edge; everything else runs on real infra.
- **The gating product decision is still yours:** run `connectors/linear-pull.ts` on real incident
  history for the D10 verdict — Loop A first, or fix delivery friction first.
