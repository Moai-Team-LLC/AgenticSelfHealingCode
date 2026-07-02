/**
 * @sho/adapter-agenticops — OPTIONAL platform adapter (INTEGRATIONS.md): SHO's Telemetry and
 * Backlog ports mapped onto AgenticOps (fleet-ops runtime). Standalone-first: the platform
 * instances are injected duck-typed, never imported; the in-repo defaults in @sho/contracts
 * remain the zero-dep fallback.
 */

export {
  AgenticOpsTelemetry,
  type AgenticOpsTelemetryOptions,
  type AgenticOpsTelemetryLike,
  type AgenticOpsAuditInput,
  type AgenticOpsAuditKind,
} from './telemetry'
export {
  AgenticOpsBacklog,
  type AgenticOpsBacklogOptions,
  type AgenticOpsBacklogLike,
  type AgenticOpsEnqueueOptions,
} from './backlog'
