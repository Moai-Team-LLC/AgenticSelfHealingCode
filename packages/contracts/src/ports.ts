/**
 * Platform ports (INTEGRATIONS.md). SHO is standalone-first: each port has a zero-dep in-repo default,
 * and the optional adapters (packages/adapter-*) map it onto AgenticOps / AgenticMind / APL when those
 * platforms are present. Ports are deliberately tiny — the platform owns the semantics; SHO only emits.
 */

import type { Tier } from './types'

// ── Telemetry port (→ AgenticOps Telemetry / APL OTel ingest) ────────────────

/** The operational events SHO emits. `data` is small structured detail, never free-form logs. */
export interface TelemetryEvent {
  kind: 'harm' | 'trust_transition' | 'gate_result' | 'rca_outcome' | 'mttr_split' | 'llm_cost'
  at: string // ISO
  classKey?: string
  incidentId?: string
  data: Record<string, unknown>
}

export interface TelemetrySink {
  emit(e: TelemetryEvent): void | Promise<void>
}

/** Standalone default: record in memory (inspectable in tests), no I/O. */
export class InMemoryTelemetry implements TelemetrySink {
  readonly events: TelemetryEvent[] = []
  emit(e: TelemetryEvent): void {
    this.events.push(e)
  }
}

// ── Backlog port (→ AgenticOps Backlog) ─────────────────────────────────────

/** A unit of human/agent work SHO surfaces: an approval to decide, an incident to watch. */
export interface WorkItem {
  id: string // SHO-side id (approval_request id / incident id) — idempotency key for adapters
  kind: 'approval' | 'incident'
  title: string
  classKey?: string
  tier?: Tier
  payload: Record<string, unknown>
}

export interface BacklogPort {
  /** Enqueue (idempotent on item.id — re-enqueueing an existing id is a no-op). */
  enqueue(item: WorkItem): void | Promise<void>
  /** Terminal outcome for an item (approved / rejected / resolved / expired …). */
  complete(id: string, outcome: string): void | Promise<void>
}

/** Standalone default: the in-repo queue state (inspectable), no I/O. */
export class InMemoryBacklog implements BacklogPort {
  readonly items = new Map<string, { item: WorkItem; outcome?: string }>()
  enqueue(item: WorkItem): void {
    if (!this.items.has(item.id)) this.items.set(item.id, { item })
  }
  complete(id: string, outcome: string): void {
    const cur = this.items.get(id)
    if (cur) cur.outcome = outcome
  }
}
