/**
 * The churn escalator (TRUST-CONTROLLER.md §4.1). Three separate small green fixes can each pass the stateless
 * gate individually while compounding into one thrashing module_area. This area-keyed guard catches that: once
 * `max` actions land in an area within a `windowH`-hour burst, the area is put on a churn HOLD for `quietH`
 * hours — no further autonomous action (auto-apply, or even auto-proposing a new PR) into it until it settles.
 *
 * Pure over (action timestamps, nowMs) so it is replayable and needs no stored "tripped_at": a hold exists iff,
 * among the actions still inside the quiet window, some `max` of them fall within a single `windowH` window.
 * Loop C never decides this itself — the app feeds the area's action times and treats the answer as a ceiling.
 */

export interface ChurnConfig {
  max: number // CHURN_MAX — actions per area that trip a burst
  windowH: number // the burst window, hours (H)
  quietH: number // how long the hold persists after a burst, hours (CHURN_QUIET)
}

export const DEFAULT_CHURN: ChurnConfig = { max: 3, windowH: 6, quietH: 12 }

const HOUR_MS = 3_600_000

/** True iff the area is under a churn hold at `nowMs` given its action timestamps (ms). */
export function churnHold(actionTimesMs: readonly number[], nowMs: number, cfg: ChurnConfig = DEFAULT_CHURN): boolean {
  // Only actions still within the quiet window can hold; sort ascending to scan for a burst.
  const recent = actionTimesMs.filter((t) => t <= nowMs && nowMs - t < cfg.quietH * HOUR_MS).sort((a, b) => a - b)
  if (recent.length < cfg.max) return false
  // A burst = `max` actions spanning less than windowH. If any window of `max` consecutive actions is that tight,
  // the area tripped inside the quiet window and is held.
  for (let i = 0; i + cfg.max - 1 < recent.length; i++) {
    if (recent[i + cfg.max - 1]! - recent[i]! < cfg.windowH * HOUR_MS) return true
  }
  return false
}
