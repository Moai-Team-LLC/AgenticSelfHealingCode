/**
 * Fold a class's OutcomeEvent stream into the stats the control law needs. Pure and deterministic
 * (order-independent for the aggregates). A "caused-incident" = the change harmed something: a
 * recurrence, a new-incident-spawn in the touched area, or a later human revert (D6, harm metric).
 */

import type { OutcomeEvent } from '@sho/contracts'

const CAUSED: ReadonlySet<string> = new Set(['recurrence', 'spawn', 'spawn_contested', 'revert'])

export interface ClassStats {
  applied: number
  confirmedGood: number // 'matured' with no harm attributed = confirmed-good
  caused: number // recurrence | spawn | spawn_contested | revert
  decided: number // confirmedGood + caused
  confirmedGoodRate: number // confirmedGood / decided (0 when nothing decided)
  firstAppliedAtMs?: number
  lastCausedAtMs?: number
}

export function foldClass(events: OutcomeEvent[]): ClassStats {
  let applied = 0, confirmedGood = 0, caused = 0
  let firstAppliedAtMs: number | undefined
  let lastCausedAtMs: number | undefined
  for (const e of events) {
    const at = Date.parse(e.at)
    if (e.kind === 'applied') {
      applied++
      if (Number.isFinite(at) && (firstAppliedAtMs === undefined || at < firstAppliedAtMs)) firstAppliedAtMs = at
    } else if (e.kind === 'matured') {
      confirmedGood++
    } else if (CAUSED.has(e.kind)) {
      caused++
      if (Number.isFinite(at) && (lastCausedAtMs === undefined || at > lastCausedAtMs)) lastCausedAtMs = at
    }
  }
  const decided = confirmedGood + caused
  return { applied, confirmedGood, caused, decided, confirmedGoodRate: decided > 0 ? confirmedGood / decided : 0, firstAppliedAtMs, lastCausedAtMs }
}
