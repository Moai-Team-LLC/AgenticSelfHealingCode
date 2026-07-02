# Integrations — optional AgenticOps / AgenticMind

Self-Healing Ops (SHO) is a **standalone** open-source product: it runs end-to-end on Postgres +
pgvector with nothing else (see the top-level README). But it shares DNA with two sibling OSS
projects, and when they're present SHO plugs into them as a first-class app on the platform:

- **[AgenticMind](https://github.com/Moai-Team-LLC/AgenticMind)** — the pgvector why-trace memory engine
  (retrieval, judge-gated, anti-hallucination). SHO's Incident Memory *is* this pattern.
- **AgenticOps** — the operational substrate (Backlog + Telemetry + durable execution). SHO's
  orchestration, approvals, and metrics map onto it.

The rule is the same one used everywhere in this repo: **every integration is an optional adapter
behind an interface, with an in-repo default**, selected by config/env. Nothing here is a hard
dependency; SHO never *requires* AgenticOps or AgenticMind.

## The seam — SHO port → optional adapter

| SHO interface (standalone default) | Optional adapter | Backing capability |
|---|---|---|
| `IncidentMemory` (`@sho/incident-memory`: `InMemoryIncidentMemory` / `PostgresIncidentMemory`) | `AgenticMindIncidentMemory` | AgenticMind's pgvector why-trace store + outcome-weighted retrieval. SHO already re-embeds to 1536 and stores why-traces the same way — delegate instead of owning the tables. |
| RCA retrieval tool (`@sho/loop-a` `MemoryRetrieveTool`) | AgenticMind retrieval | AgenticMind semantic / GraphRAG retrieval over past incidents (few-shot "we fixed this in March"). |
| **`Telemetry`** *(new port to add)* — harm metric, MTTR split, trust-level transitions, LLM cost | `AgenticOpsTelemetry` | AgenticOps Telemetry primitive. Default: a no-op / stdout emitter. |
| **`Backlog`** *(new port to add)* — the HITL approval queue + incident lifecycle as work items | `AgenticOpsBacklog` | AgenticOps Backlog primitive. Default: the in-repo `ApprovalQueue` (`@sho/hitl`) + `orch.*` tables. |
| Durable execution (`@sho/orchestrator` Pg stores) | AgenticOps durable runtime | AgenticOps durable state machine could host the incident lifecycle; SHO's Postgres stores are the standalone default. |
| RCA LLM (`@sho/loop-a` `LlmClient`) | already `@sho/adapters` `ClaudeLlmClient` | (not platform-specific) |

## Why this shape

- **Standalone first.** A team with just a repo + CI + Postgres gets the whole product. That's the
  OSS adoption path and keeps SHO honest.
- **Showcase second.** When AgenticOps/AgenticMind are present, SHO is a flagship reference app —
  demonstrating the platform without coupling the OSS product's release or license to it.
- **No rework.** The interfaces already exist (`IncidentMemory` is a port today; `Telemetry`/`Backlog`
  are small additions). Adapters slot in exactly like the Postgres/Claude/Telegram ones.

## Implemented adapters

All three are built and verified — offline tests with fakes shaped from the **real** target sources,
plus live-verify scripts that exercise the real code where a server isn't required:

| Package | Maps | Verified against the real target |
|---|---|---|
| [`@sho/adapter-agenticops`](packages/adapter-agenticops/) | `TelemetrySink` → `Telemetry.audit(AuditInput)` with honest `AuditKind` mapping per event kind; `BacklogPort` → `Backlog.enqueue/complete` with adapter-side idempotency on `WorkItem.id` (the real `EnqueueOptions` has no dedupe key) | ✅ `verify-live.ts` imports the **real** AgenticOps classes and drives them on `:memory:` SQLite — 17 checks |
| [`@sho/adapter-agenticmind`](packages/adapter-agenticmind/) | Incident memory over MCP contract **v1.2.0**: `recordIncident`+why-trace → `kl_ingest`; outcome labels → `mem_write` (`sho:outcome` beliefs) + `kl_signal` (±1 on terminal polarities); `retrieveSimilar` → `kl_search` + per-hit `mem_recall` polarity join → the same exemplar/anti-pattern ranking as the in-repo store | ✅ all emitted payloads validated against the **real** zod input schemas from the clone; live-server rung gated on `AGENTICMIND_MCP_URL` |
| [`@sho/adapter-apl`](packages/adapter-apl/) | `TelemetrySink` → APL's OTel contract: `rca_outcome`→`apl.outcome`, gate results as `execute_tool` child spans, `llm_cost`→`gen_ai.usage.*`, mandatory `apl.tenant_id`/`apl.agent_id` resource/span attrs — names copied verbatim from `contract.ts` | ✅ round-trip through APL's **real** `normalizeGenAI`/`validateTrace` — zero contract violations |

The ports (`TelemetrySink`, `BacklogPort`, `WorkItem`) live in `@sho/contracts` with in-memory
standalone defaults. Conformance to the Agentic Product Standard is mapped in
[`CONFORMANCE.md`](CONFORMANCE.md) (including an honest gaps table).

## Licensing note

SHO ships under Apache-2.0 (matching AgenticMind). The optional adapters live in this repo and depend
on the sibling projects only when enabled, so SHO's license stays clean and self-contained.
