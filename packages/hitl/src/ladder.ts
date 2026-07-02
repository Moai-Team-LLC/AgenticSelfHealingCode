/**
 * §3 — THE ASYNC APPROVAL LADDER. A durable queue of `approval_request` rows with a per-tier timeout and
 * escalation, modeled as PURE STEP FUNCTIONS over (queue, nowMs) so it is replayable and testable with no
 * timers. The real substrate is AgenticOps Postgres (the bot is only a view over these rows); here the
 * store is in-memory and every timer is `escalate_at` compared to an injected `nowMs`.
 *
 * The two rules that fix the dark-hours failure (§3.3):
 *   Tier 3 — no answer in N min → SECONDARY approver; second timeout → page the on-call bridge. NEVER
 *            auto-approves and NEVER auto-rejects: it keeps finding a human.
 *   Tier 4 — no answer → AUTO-REJECT with notification. The most dangerous class must NEVER pass by default.
 *   Tier 2 — a propose/off-hours-downgrade PR is not urgent-fatal: escalate then remind; a stale PR is
 *            harmless (never auto-approves, never auto-rejects).
 */

export type ApprovalTier = 2 | 3 | 4
export type ApprovalLoop = 'B' | 'C'

export type ApprovalState = 'OPEN' | 'ESCALATED' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'SUPERSEDED'

/** Why an escalation timer fired last (audit-shaped, descriptive). */
export type LadderReason = 'off_hours' | 'tier3' | 'tier4' | 'churn_escalate'

export interface ApprovalRequest {
  id: string
  incidentId: string
  classKey: string
  loop: ApprovalLoop
  tier: ApprovalTier
  requestedLevel: number // the L the router resolved (may exceed the applied path)
  downgradedFrom: number | null // set iff off-hours business-hours downgrade (§2.3)
  reason: LadderReason | null
  whyTraceId: string
  fixSha: string | null // NULL for a Tier-4 plan-approval (no authored diff)
  parentSha: string | null // NULL for a Tier-4 plan-approval
  team: string
  state: ApprovalState
  primaryApprover: string | null
  currentApprover: string | null
  verdictBy: string | null // DESCRIPTIVE audit only — never the accountability owner (§4.3)
  verdictAtMs: number | null
  telegramMsgRef: string | null
  createdAtMs: number
  escalateAtMs: number | null // next ladder timer fire
}

/** Per-tier ladder config (hitl-ladder.yaml, §3.2). Minutes → ms at use sites. */
export interface LadderConfig {
  tier2: { primaryTimeoutMin: number; secondaryTimeoutMin: number }
  tier3: { primaryTimeoutMin: number; secondaryTimeoutMin: number }
  tier4: { primaryTimeoutMin: number }
}

export const DEFAULT_LADDER: LadderConfig = {
  tier2: { primaryTimeoutMin: 120, secondaryTimeoutMin: 240 },
  tier3: { primaryTimeoutMin: 20, secondaryTimeoutMin: 20 },
  tier4: { primaryTimeoutMin: 15 },
}

const MIN = 60_000

// ── crosswalk invariant (Revise addendum #6): tier < 3 OR loop = 'C' ─────────
export function isCrosswalkLegal(tier: ApprovalTier, loop: ApprovalLoop): boolean {
  return tier < 3 || loop === 'C'
}
/** A Tier-4 row is a plan-approval with no authored diff (§3.1 tier4_is_plan_no_diff). */
export function isTier4PlanShape(r: Pick<ApprovalRequest, 'tier' | 'fixSha' | 'parentSha'>): boolean {
  return r.tier !== 4 || (r.fixSha === null && r.parentSha === null)
}

export interface EnqueueInput {
  id: string
  incidentId: string
  classKey: string
  loop: ApprovalLoop
  tier: ApprovalTier
  requestedLevel: number
  whyTraceId: string
  team: string
  primaryApprover: string | null
  secondaryApprover: string | null
  fixSha?: string | null
  parentSha?: string | null
  downgradedFrom?: number | null
  reason?: LadderReason | null
  telegramMsgRef?: string | null
}

/** The durable queue. In-memory here; a real adapter is thin code over Postgres with the same steps. */
export class ApprovalQueue {
  private rows = new Map<string, ApprovalRequest>()
  private secondaryOf = new Map<string, string | null>() // requestId → secondary approver

  enqueue(input: EnqueueInput, nowMs: number, cfg: LadderConfig = DEFAULT_LADDER): ApprovalRequest {
    if (!isCrosswalkLegal(input.tier, input.loop)) {
      throw new Error(`crosswalk-illegal approval: tier=${input.tier} requires loop='C' (got '${input.loop}')`)
    }
    const fixSha = input.fixSha ?? null
    const parentSha = input.parentSha ?? null
    if (input.tier === 4 && (fixSha !== null || parentSha !== null)) {
      throw new Error('tier-4 approval is a plan-approval and must carry no diff (fix_sha/parent_sha null)')
    }
    const row: ApprovalRequest = {
      id: input.id,
      incidentId: input.incidentId,
      classKey: input.classKey,
      loop: input.loop,
      tier: input.tier,
      requestedLevel: input.requestedLevel,
      downgradedFrom: input.downgradedFrom ?? null,
      reason: input.reason ?? null,
      whyTraceId: input.whyTraceId,
      fixSha,
      parentSha,
      team: input.team,
      state: 'OPEN',
      primaryApprover: input.primaryApprover,
      currentApprover: input.primaryApprover,
      verdictBy: null,
      verdictAtMs: null,
      telegramMsgRef: input.telegramMsgRef ?? null,
      createdAtMs: nowMs,
      escalateAtMs: nowMs + primaryTimeoutMin(input.tier, cfg) * MIN,
    }
    this.rows.set(row.id, row)
    this.secondaryOf.set(row.id, input.secondaryApprover)
    return row
  }

  get(id: string): ApprovalRequest | undefined { return this.rows.get(id) }
  secondaryApprover(id: string): string | null { return this.secondaryOf.get(id) ?? null }
  open(): ApprovalRequest[] { return [...this.rows.values()].filter((r) => r.state === 'OPEN' || r.state === 'ESCALATED') }
  all(): ApprovalRequest[] { return [...this.rows.values()] }

  private replace(row: ApprovalRequest): void { this.rows.set(row.id, row) }

  /** Human verdict CAS. Approve/Reject/Edit are the only paths OUT of OPEN/ESCALATED via a human. */
  approve(id: string, verdictBy: string, nowMs: number, editedFixSha?: string): ApprovalRequest {
    return this.verdict(id, 'APPROVED', verdictBy, nowMs, editedFixSha)
  }
  reject(id: string, verdictBy: string, nowMs: number): ApprovalRequest {
    return this.verdict(id, 'REJECTED', verdictBy, nowMs)
  }
  private verdict(id: string, to: 'APPROVED' | 'REJECTED', verdictBy: string, nowMs: number, editedFixSha?: string): ApprovalRequest {
    const row = this.require(id)
    if (row.state !== 'OPEN' && row.state !== 'ESCALATED') {
      throw new Error(`approval ${id} is terminal (${row.state}); no verdict admitted`)
    }
    const next: ApprovalRequest = {
      ...row,
      state: to,
      verdictBy, // DESCRIPTIVE only (§4.3) — never accountable_owner
      verdictAtMs: nowMs,
      escalateAtMs: null,
      fixSha: to === 'APPROVED' && editedFixSha !== undefined ? editedFixSha : row.fixSha,
    }
    this.replace(next)
    return next
  }

  /** Request cancellation because the incident reached a terminal state (§3.2). NOT the outcome label. */
  supersede(id: string, nowMs: number): ApprovalRequest {
    const row = this.require(id)
    if (row.state === 'APPROVED' || row.state === 'REJECTED' || row.state === 'EXPIRED') return row
    const next: ApprovalRequest = { ...row, state: 'SUPERSEDED', escalateAtMs: null, verdictAtMs: nowMs }
    this.replace(next)
    return next
  }

  /**
   * THE LADDER STEP — pure over (queue, nowMs). Fire every due timer exactly once and return the audit
   * events produced. Deterministic: replaying with the same nowMs yields the same transitions. This is the
   * `escalate_at`-scan the orchestrator drives; it never holds a socket or an in-memory setTimeout.
   */
  tick(nowMs: number, cfg: LadderConfig = DEFAULT_LADDER): LadderEvent[] {
    const events: LadderEvent[] = []
    for (const row of this.open()) {
      if (row.escalateAtMs === null || nowMs < row.escalateAtMs) continue
      events.push(this.fire(row, nowMs, cfg))
    }
    return events
  }

  private fire(row: ApprovalRequest, nowMs: number, cfg: LadderConfig): LadderEvent {
    if (row.tier === 4) {
      // Tier 4: silence must DENY. Auto-reject + notify; the most dangerous class defaults to "no".
      const next: ApprovalRequest = { ...row, state: 'REJECTED', reason: 'tier4', verdictBy: null, verdictAtMs: nowMs, escalateAtMs: null }
      this.replace(next)
      return { kind: 'auto_reject', requestId: row.id, tier: 4, atMs: nowMs, notify: true }
    }
    if (row.tier === 3) {
      // Tier 3: silence must FIND A HUMAN. OPEN→ESCALATED (to secondary); ESCALATED→page bridge, stay open.
      if (row.state === 'OPEN') {
        const secondary = this.secondaryApprover(row.id)
        const next: ApprovalRequest = {
          ...row,
          state: 'ESCALATED',
          reason: 'tier3',
          currentApprover: secondary,
          escalateAtMs: nowMs + cfg.tier3.secondaryTimeoutMin * MIN,
        }
        this.replace(next)
        return { kind: 'escalate_to_secondary', requestId: row.id, tier: 3, atMs: nowMs, to: secondary }
      }
      // already ESCALATED — page the on-call bridge; stays ESCALATED, never auto-anything
      const next: ApprovalRequest = { ...row, escalateAtMs: null }
      this.replace(next)
      return { kind: 'page_oncall_bridge', requestId: row.id, tier: 3, atMs: nowMs }
    }
    // Tier 2: escalate then remind; a stale PR is harmless. Never auto-approves/rejects.
    if (row.state === 'OPEN') {
      const secondary = this.secondaryApprover(row.id)
      const next: ApprovalRequest = {
        ...row,
        state: 'ESCALATED',
        currentApprover: secondary,
        escalateAtMs: nowMs + cfg.tier2.secondaryTimeoutMin * MIN,
      }
      this.replace(next)
      return { kind: 'escalate_to_secondary', requestId: row.id, tier: 2, atMs: nowMs, to: secondary }
    }
    const next: ApprovalRequest = { ...row, escalateAtMs: null }
    this.replace(next)
    return { kind: 'remind', requestId: row.id, tier: 2, atMs: nowMs }
  }

  private require(id: string): ApprovalRequest {
    const row = this.rows.get(id)
    if (!row) throw new Error(`approval_request ${id} not found`)
    return row
  }
}

/** Audit-shaped outputs of a ladder tick (each is one durable, replayable transition). */
export type LadderEvent =
  | { kind: 'escalate_to_secondary'; requestId: string; tier: ApprovalTier; atMs: number; to: string | null }
  | { kind: 'page_oncall_bridge'; requestId: string; tier: 3; atMs: number }
  | { kind: 'remind'; requestId: string; tier: 2; atMs: number }
  | { kind: 'auto_reject'; requestId: string; tier: 4; atMs: number; notify: boolean }

function primaryTimeoutMin(tier: ApprovalTier, cfg: LadderConfig): number {
  switch (tier) {
    case 2: return cfg.tier2.primaryTimeoutMin
    case 3: return cfg.tier3.primaryTimeoutMin
    case 4: return cfg.tier4.primaryTimeoutMin
  }
}
