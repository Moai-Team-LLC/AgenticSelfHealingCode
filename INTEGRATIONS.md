# Integrations — optional AgenticOps / AgenticMind

Self-Healing Ops (SHO) is a **standalone** open-source product: it runs end-to-end on Postgres +
pgvector with nothing else (see the top-level README). But it shares DNA with two sibling OSS
projects, and when they're present SHO plugs into them as a first-class app on the platform:

- **[AgenticMind](https://github.com/AlexDuchDev/agenticmind)** — the pgvector why-trace memory engine
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

## To wire the real adapters (next, concrete)

Both platforms are OSS and cloned in the workspace, so these are buildable, not hypothetical. Each
needs the counterpart's client surface:

1. **`AgenticMindIncidentMemory`** — needs AgenticMind's store client (write why-trace + embedding,
   vector search with outcome labels, label lifecycle). Implement SHO's `IncidentMemory` port over it;
   verify with the same `verify-pg.ts`-style live checks.
2. **`Telemetry` port + `AgenticOpsTelemetry`** — add a tiny `Telemetry` interface to `@sho/contracts`
   (or a new `@sho/observability`), emit from the Trust Controller (harm/transition) and the D10
   instrument (MTTR), with a no-op default; adapter forwards to AgenticOps Telemetry.
3. **`Backlog` port + `AgenticOpsBacklog`** — map `@sho/hitl` `ApprovalQueue` + incident lifecycle onto
   AgenticOps Backlog work items.

Point me at the AgenticMind / AgenticOps repos (or confirm the clone paths) and I'll build these
against their real APIs and live-verify them, same as the Postgres path.

## Licensing note

SHO ships under Apache-2.0 (matching AgenticMind). The optional adapters live in this repo and depend
on the sibling projects only when enabled, so SHO's license stays clean and self-contained.
