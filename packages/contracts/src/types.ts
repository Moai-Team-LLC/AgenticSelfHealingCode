/**
 * @sho/contracts — the shared contract spine. Every product package imports these; nothing here
 * imports anything. The values are the ones ARCHITECTURE-REFRAMED.md arbitrated (D1–D10), so no
 * package re-derives a divergent shape (that was the coherence failure the design already fixed).
 */

// ── Loop / tier / autonomy crosswalk (ARCHITECTURE-REFRAMED §2) ──────────────

/** Which loop authored an action. */
export type Loop = 'A' | 'B' | 'C'
/** The trust-class taxonomy (finer than Loop): keys autonomy per behavior. */
export type TrustLoop = 'A_rca' | 'B_flaky' | 'B_heal' | 'C_repair'
/** Risk/route class of an action (ARCH-ORIG §5). Tier 4 is NEVER autonomous. */
export type Tier = 1 | 2 | 3 | 4
/** How much autonomy a given incident-class has earned right now. */
export type AutonomyLevel = 'L0' | 'L1' | 'L2' | 'L3'

// ── Incident signal (ARCH-ORIG §2, extended by the reframe) ─────────────────

export type SignalSource = 'sentry' | 'otel' | 'rum' | 'business-metric'
/** Shape of the signal over time — drives the deploy-anchoring branch (LOOP-A §3, attack #5). */
export type SignalShape = 'step' | 'slope' | 'spike' | 'unknown'

export interface IncidentCandidate {
  id: string
  source: SignalSource
  fingerprint: string
  severity: number
  first_seen: string // ISO
  occurrences: number
  affected_service: string
  affected_paths: string[]
  recent_deploys: { deploy_id: string; ts: string; diff_url?: string }[]
  shape: SignalShape
  raw_payload: unknown
}

// ── Grounded why-trace (LOOP-A §5; confidence = observed booleans, D3) ──────

export interface GroundedConfidence {
  reproduced: boolean | null // sandbox reproduced the signal (null = not attempted)
  explainsAllOccurrences: boolean | null // G2 mechanical occurrence match
  affectedPathInDeployDiff: boolean | null // G3
  stepVsSlopeConsistent: boolean | null // G6
}
export type CorrelationState = 'deploy_linked' | 'no_recent_deploy' | 'ambiguous'

export interface WhyTrace {
  incidentId: string
  hypothesis: string
  alternatives: string[]
  confidence: GroundedConfidence
  correlationState: CorrelationState
  affectedComponents: string[]
  fixClass: 'code' | 'config' | 'infra' | 'data'
  recommendedAction: string
  suspiciousContentFlag: boolean // untrusted telemetry text seen (D7)
  similarIncidents: { id: string; outcome: OutcomeLabel; resolutionRef?: string }[]
}

// ── Verification gate result (VERIFICATION-GATE.md; mirrors gate/verify.ts) ──

export interface GateSignals {
  mustFailOnParent: { pass: boolean; code: 'DISCRIMINATING' | 'VACUOUS' | 'UNFIXED' | 'INFRA' }
  mutationScore: { pass: boolean; score: number | null; threshold: number }
  noWeakening: { pass: boolean } | null
  diffLines: number
  exceedsClassBudget: boolean
}
export interface GateResult {
  pass: boolean
  moduleArea: string
  loop?: Loop
  tier?: Tier
  signals: GateSignals
  reason: string
}

// ── Outcome events + labels (INCIDENT-MEMORY ↔ TRUST-CONTROLLER, §3.2/§3.6) ──

/** The ONE canonical field name is `actionId` (not autoActionId) — keystone §3.2. */
export type OutcomeEventKind = 'applied' | 'recurrence' | 'spawn' | 'spawn_contested' | 'revert' | 'matured'
export interface OutcomeEvent {
  actionId: string
  kind: OutcomeEventKind
  at: string // ISO
}

/** Stored outcome label on resolutions.ck_outcome_label (keystone §3.6). */
export type OutcomeLabel =
  | 'proposed'
  | 'applied'
  | 'provisional_human_confirmed'
  | 'confirmed_good'
  | 'recurred'
  | 'reverted'
  | 'wrong_rca'
  | 'superseded'

/** The immutable landing record (orch.auto_action; keystone §3.2 DDL, see sql.ts). */
export interface AutoAction {
  action_id: string
  incident_id: string
  class_key: string // (module_area, symptom_signature)
  loop: 'B' | 'C' // A never writes: no change
  applied_by: 'machine' | 'human_approved'
  applied_at: string
  fix_sha: string
  parent_sha: string
  gate_result: GateResult
  accountable_owner: string // = trust_class.owner (D9), frozen here
  module_area: string
}

// ── Loop B discriminator (LOOP-B-SPEC.md) ───────────────────────────────────

export type BrokenClass = 'A_regression' | 'B_stale_candidate' | 'C_flaky' | 'D_infra'
export interface LoopBDecision {
  cls: BrokenClass
  autonomous: boolean
  action: string
  reason: string
}

// ── Maturation windows (keystone §3.5; W_confirm DELETED) ────────────────────

export const WINDOWS_DAYS = { W_recur: 14, W_spawn: 14, W_revert: 30, W_mature: 30 } as const
