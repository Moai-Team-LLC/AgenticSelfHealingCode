/**
 * AgenticOpsTelemetry — SHO's TelemetrySink mapped onto AgenticOps fleet telemetry
 * (AgenticOps/src/telemetry/telemetry.ts). The AgenticOps Telemetry instance is INJECTED,
 * duck-typed from the real class's public surface — this package never imports the platform.
 *
 * Each SHO event kind maps to the semantically-matching AuditKind from the real vocabulary
 * ("lifecycle" | "auth" | "tool"), mirroring how AgenticOps itself uses them (delegate.ts:
 * `auth` = permission decisions, `lifecycle` = work-lifecycle progress, `tool` = executions
 * and their effects):
 *   harm             → tool       observed effect of an action SHO actuated (bad outcome of an applied fix)
 *   trust_transition → auth       autonomy-level change = change in what the class is AUTHORIZED to do
 *   gate_result      → auth       the verification gate is an authorization decision on landing a fix
 *   rca_outcome      → lifecycle  a diagnostic unit of work concluded
 *   mttr_split       → lifecycle  incident-lifecycle phase timing
 *   llm_cost         → tool       an LLM invocation (OTel-GenAI: a tool/model call) and its cost
 *
 * The SHO event time (e.at, ISO) is passed as the audit's `now` so the durable record carries
 * event time, not write time; an unparseable timestamp falls back to the real API's own default.
 */

import type { TelemetryEvent, TelemetrySink } from '@sho/contracts'

// ── Duck-typed surface, copied from AgenticOps src/telemetry/telemetry.ts ────
export type AgenticOpsAuditKind = 'lifecycle' | 'auth' | 'tool'
export interface AgenticOpsAuditInput {
  agent: string
  kind: AgenticOpsAuditKind
  action: string
  detail?: unknown
}
export interface AgenticOpsTelemetryLike {
  /** Real signature: audit(ev: AuditInput, now = Date.now()): number */
  audit(ev: AgenticOpsAuditInput, now?: number): number
}

const AUDIT_KIND: Record<TelemetryEvent['kind'], AgenticOpsAuditKind> = {
  harm: 'tool',
  trust_transition: 'auth',
  gate_result: 'auth',
  rca_outcome: 'lifecycle',
  mttr_split: 'lifecycle',
  llm_cost: 'tool',
}

export interface AgenticOpsTelemetryOptions {
  /** Fleet identity SHO records under (AuditEvent.agent). Default 'sho'. */
  agent?: string
}

export class AgenticOpsTelemetry implements TelemetrySink {
  constructor(
    private readonly telemetry: AgenticOpsTelemetryLike,
    private readonly opts: AgenticOpsTelemetryOptions = {},
  ) {}

  emit(e: TelemetryEvent): void {
    const at = Date.parse(e.at)
    this.telemetry.audit(
      {
        agent: this.opts.agent ?? 'sho',
        kind: AUDIT_KIND[e.kind],
        action: `sho.${e.kind}`,
        detail: { classKey: e.classKey ?? null, incidentId: e.incidentId ?? null, data: e.data },
      },
      Number.isFinite(at) ? at : undefined,
    )
  }
}
