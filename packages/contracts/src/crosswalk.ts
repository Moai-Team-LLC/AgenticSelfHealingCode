/** L ↔ tier ↔ loop crosswalk (ARCHITECTURE-REFRAMED §2). The single mapping; nothing re-derives it. */
import type { AutonomyLevel, Tier, TrustLoop, Loop } from './types'

/** Autonomy level → the tier the Verification Gate is handed. Tier 4 is never reachable autonomously. */
export function levelToTier(level: AutonomyLevel): Tier {
  switch (level) {
    case 'L0': return 1 // diagnose only (kill-switch floor)
    case 'L1': return 2 // propose, human merges (PR)
    case 'L2': return 2 // auto-apply, reversible, low blast radius
    case 'L3': return 3 // auto-apply, business-hours, proven-reversible
  }
}

/** Is this level an auto-apply level (no human merge in the loop)? */
export function isAutoApply(level: AutonomyLevel): boolean {
  return level === 'L2' || level === 'L3'
}

/** Map a (loop, actionKind) to the trust-class taxonomy (ORCHESTRATION router's toTrustLoop). */
export function toTrustLoop(loop: Loop, actionKind?: string): TrustLoop {
  if (loop === 'A') return 'A_rca'
  if (loop === 'C') return 'C_repair'
  // loop B: disambiguate by action kind
  return actionKind === 'quarantine' ? 'B_flaky' : 'B_heal'
}

/** auto_action.loop enum ('B' | 'C') from the trust-class loop. Loop A never writes an action. */
export function autoActionLoop(trustLoop: TrustLoop): 'B' | 'C' | null {
  if (trustLoop === 'C_repair') return 'C'
  if (trustLoop === 'B_flaky' || trustLoop === 'B_heal') return 'B'
  return null // A_rca authors no change
}
