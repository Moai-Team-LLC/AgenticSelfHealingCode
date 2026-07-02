/**
 * The router (ARCHITECTURE-REFRAMED §2, coherence #7). Maps a class's earned autonomy to the tuple the
 * Verification Gate is handed. It reads the THREE class-keyed Trust-Controller values (effectiveLevel,
 * requiredMutationScore, accountabilityOwner), applies the kill bit (forces L0), and never moves the
 * tier itself (split-brain avoidance — the gate reports, the controller decides).
 */

import { levelToTier, type AutonomyLevel, type Loop, type Tier, type OutcomeEvent } from '@sho/contracts'
import { effectiveLevel, requiredMutationScore } from '@sho/trust-controller'

export interface RouteInput {
  classKey: string
  loop: Loop
  owner: string | null // trust_class.owner (D9 authoritative source)
  outcomeEvents: OutcomeEvent[] // the class's full stream (for effectiveLevel)
  parentSHA: string
  fixSHA: string
}

export interface GateCall {
  loop: Loop
  tier: Tier
  level: AutonomyLevel
  requiredMutationScore: number
  accountableOwner: string | null // passed through; the gate HARD-FAILs the auto column if null (D9)
  parentSHA: string
  fixSHA: string
}

export function route(input: RouteInput, nowMs: number, opts: { killed: boolean }): GateCall {
  const { level } = effectiveLevel(input.outcomeEvents, nowMs, { killed: opts.killed })
  return {
    loop: input.loop,
    tier: levelToTier(level),
    level,
    requiredMutationScore: requiredMutationScore(level),
    accountableOwner: input.owner,
    parentSHA: input.parentSHA,
    fixSHA: input.fixSHA,
  }
}
