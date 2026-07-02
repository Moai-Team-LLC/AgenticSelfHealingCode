/**
 * The autonomy control law (TRUST-CONTROLLER.md, D6). Expansion is driven by measured OUTCOMES, never
 * by the absence of a human veto. It is deliberately asymmetric — slow to promote, immediate to
 * demote — which is what closes the positive-feedback runaway (STRESS-TEST §3):
 *   - promote a level only after ≥K confirmed-good outcomes AND rate ≥ θ AND a clean recent window AND
 *     enough calendar dwell;
 *   - a single caused-incident inside the window collapses the level (recomputed from evidence, so a
 *     fresh harm event drops it immediately);
 *   - the kill switch forces L0 for every class.
 * Because promotion requires confirmed-good outcomes, "nobody rejected anything" (low override) never
 * promotes on its own — the exact ambiguity D6 rejects.
 */

import type { AutonomyLevel, OutcomeEvent } from '@sho/contracts'
import { foldClass, type ClassStats } from './fold'

const DAY = 86_400_000

export interface TransitionGate { K: number; theta: number; dMinDays: number }
export interface TrustConfig { toL2: TransitionGate; toL3: TransitionGate }

export const DEFAULT_TRUST_CONFIG: TrustConfig = {
  toL2: { K: 30, theta: 0.98, dMinDays: 14 },
  toL3: { K: 100, theta: 0.99, dMinDays: 45 },
}

/** Effective per-class mutation bar handed to the Verification Gate (keystone §3.4). */
export function requiredMutationScore(level: AutonomyLevel): number {
  switch (level) {
    case 'L0': case 'L1': return 0.6
    case 'L2': return 0.75
    case 'L3': return 0.8
  }
}

function meetsGate(s: ClassStats, g: TransitionGate, nowMs: number): boolean {
  if (s.confirmedGood < g.K) return false
  if (s.confirmedGoodRate < g.theta) return false
  // calendar dwell since first auto-apply
  if (s.firstAppliedAtMs === undefined || nowMs - s.firstAppliedAtMs < g.dMinDays * DAY) return false
  // strict zero caused-incidents in the recent window (immediate-demote source)
  if (s.lastCausedAtMs !== undefined && nowMs - s.lastCausedAtMs < g.dMinDays * DAY) return false
  return true
}

export interface EffectiveLevelResult {
  level: AutonomyLevel
  stats: ClassStats
  reason: string
}

/**
 * Compute a class's current autonomy level from its outcome stream. `killed` (kill switch) forces L0.
 * Base is L1 (propose / human-merges) — nothing is auto by default.
 */
export function effectiveLevel(events: OutcomeEvent[], nowMs: number, opts?: { killed?: boolean; config?: TrustConfig }): EffectiveLevelResult {
  const stats = foldClass(events)
  if (opts?.killed) return { level: 'L0', stats, reason: 'kill switch engaged — diagnosis only' }
  const cfg = opts?.config ?? DEFAULT_TRUST_CONFIG
  const l2 = meetsGate(stats, cfg.toL2, nowMs)
  const l3 = l2 && meetsGate(stats, cfg.toL3, nowMs)
  const level: AutonomyLevel = l3 ? 'L3' : l2 ? 'L2' : 'L1'
  const recentCaused = stats.lastCausedAtMs !== undefined && nowMs - stats.lastCausedAtMs < cfg.toL2.dMinDays * DAY
  const reason = level === 'L1'
    ? recentCaused
      ? `held at L1 — caused-incident within ${cfg.toL2.dMinDays}d (fast demote)`
      : `held at L1 — needs ≥${cfg.toL2.K} confirmed-good at ≥${cfg.toL2.theta} rate (have ${stats.confirmedGood} at ${stats.confirmedGoodRate.toFixed(2)})`
    : `earned ${level} on ${stats.confirmedGood} confirmed-good outcomes, rate ${stats.confirmedGoodRate.toFixed(2)}, clean window`
  return { level, stats, reason }
}

/** The harm metric the controller optimizes AGAINST (keystone §9): caused-incidents per class. */
export function harmCount(events: OutcomeEvent[]): number {
  return foldClass(events).caused
}
