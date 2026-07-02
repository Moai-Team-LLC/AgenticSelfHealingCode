/**
 * The single authoritative kill bit (ARCHITECTURE-REFRAMED §5, coherence #6). Every enforcement point
 * (Trust Controller → L0, Verification Gate → frozen, the router below) DERIVES from this one bit, so
 * they cannot disagree. Fail-safe: absence of a healthy heartbeat = KILLED (a DoS of the switch
 * degrades to diagnosis-only, the safe direction). Only a signed on-call action releases it; no agent
 * tool can toggle it.
 */

export class KillSwitch {
  private engaged = false
  private lastHeartbeatMs: number
  constructor(nowMs: number, private readonly heartbeatTtlMs = 30_000, private readonly releaseSecret?: string) {
    this.lastHeartbeatMs = nowMs
  }

  /** The orchestrator's liveness ping. */
  heartbeat(nowMs: number): void { this.lastHeartbeatMs = nowMs }

  /** Anyone/anything can engage (safe direction). */
  engage(): void { this.engaged = true }

  /** Release requires the signed on-call token (HITL-APPROVAL §6). Cannot clear a stale-heartbeat kill. */
  release(token: string): boolean {
    if (this.releaseSecret && token === this.releaseSecret) this.engaged = false
    return this.engaged
  }

  /** KILLED iff explicitly engaged OR heartbeat is stale (fail-safe). */
  isKilled(nowMs: number): boolean {
    return this.engaged || nowMs - this.lastHeartbeatMs > this.heartbeatTtlMs
  }
}
