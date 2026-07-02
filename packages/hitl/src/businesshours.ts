/**
 * §2 — THE BUSINESS-HOURS GATE (the closure of STRESS-TEST attack #6, Revise addendum #2).
 *
 * The correction is NOT "gate Tier 3." It is: ANY auto-apply (effectiveLevel ∈ {L2, L3}) outside staffed
 * business hours downgrades UNCONDITIONALLY to a propose-and-wait L1 PR (an L1 human approval). This binds
 * the previously-ungated 24/7 auto-apply path so autonomy tracks trust across the clock.
 *
 * v1 posture (addendum #2, BLOCKER): there is NO earned-off-hours escape hatch — no `hasEarnedOffHours`
 * read exists in the Trust Controller, so it is deliberately not modeled here. The one clean extension
 * point is the `else` of gateAutoApply; until the controller can answer truthfully it stays a hard
 * downgrade. Do not invent an earn path.
 *
 * The staffed-window check is a PURE function of an injected config; `nowMs` is a parameter (determinism).
 * Timezone/holiday resolution is expressed against the config so no live clock or network is touched.
 */

import { isAutoApply, type AutonomyLevel } from '@sho/contracts'

/** Weekday index matching JS Date.getUTCDay(): 0=sun … 6=sat. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6

/** A staffed interval in a team's LOCAL wall-clock (inclusive start / exclusive end), in minutes-of-day. */
export interface StaffedWindow {
  days: Weekday[]
  startMin: number // e.g. 09:00 → 540
  endMin: number // e.g. 19:00 → 1140 (exclusive)
}

/** One team's staffed schedule. `tzOffsetMin` is fixed-offset-from-UTC in minutes (e.g. Europe/Nicosia
 *  summer = +180). A full IANA tz engine is a real-adapter concern; the gate takes the resolved offset so
 *  the core stays dependency-free and deterministic. `holidays` are local YYYY-MM-DD dates — never staffed. */
export interface TeamHours {
  team: string
  tzOffsetMin: number
  staffed: StaffedWindow[]
  holidays: string[] // 'YYYY-MM-DD' in the team's local date; never staffed
}

export interface BusinessHoursConfig {
  teams: Record<string, TeamHours>
  /** Outside any staffed window → downgrade (the only v1 policy; addendum #2). */
  defaultPolicy: 'downgrade'
}

/** The effective route the gate resolves for a would-be action. */
export type AutoApplyRoute = 'auto-apply' | 'downgrade-to-PR'

const DAY_MIN = 24 * 60

/** Local wall-clock parts for a team, from UTC ms + the team's fixed offset. Pure. */
function localParts(nowMs: number, tzOffsetMin: number): { day: Weekday; minOfDay: number; date: string } {
  const local = new Date(nowMs + tzOffsetMin * 60_000)
  const day = local.getUTCDay() as Weekday
  const minOfDay = local.getUTCHours() * 60 + local.getUTCMinutes()
  const y = local.getUTCFullYear()
  const m = String(local.getUTCMonth() + 1).padStart(2, '0')
  const d = String(local.getUTCDate()).padStart(2, '0')
  return { day, minOfDay, date: `${y}-${m}-${d}` }
}

/** Is a single team staffed at `nowMs`? Holiday → false; else true iff `nowMs` is in a staffed interval. */
export function isStaffed(hours: TeamHours, nowMs: number): boolean {
  const { day, minOfDay, date } = localParts(nowMs, hours.tzOffsetMin)
  if (hours.holidays.includes(date)) return false
  return hours.staffed.some(
    (w) => w.days.includes(day) && minOfDay >= w.startMin && minOfDay < w.endMin && w.endMin <= DAY_MIN,
  )
}

/**
 * Multi-area incidents (a diff touching two areas → two teams) require ALL touched teams to be staffed —
 * the safe floor / min-across-areas rule (mirrors TRUST-CONTROLLER §7). An unknown or empty team set is
 * treated as UNSTAFFED (safe floor), never as "vacuously staffed".
 */
export function isBusinessHours(nowMs: number, cfg: BusinessHoursConfig, teams: string[]): boolean {
  if (teams.length === 0) return false
  return teams.every((t) => {
    const hours = cfg.teams[t]
    return hours ? isStaffed(hours, nowMs) : false
  })
}

/**
 * gateAutoApply — the load-bearing routing decision (§2.3). For an auto-apply level (L2/L3), returns
 * 'auto-apply' iff ALL touched teams are staffed right now; otherwise 'downgrade-to-PR' (unconditional
 * off-hours downgrade to an L1 propose-and-wait). Non-auto-apply levels (L0/L1) are never auto-applying,
 * so the gate leaves them alone — they already wait for a human by construction (returns 'auto-apply'
 * as a no-op passthrough; the caller only routes L2/L3 through here in practice).
 *
 * The single-team convenience overload matches the spec's "team := teamsFor(touched_areas)". The gate
 * NEVER mutates the class's earned level — this is a routing decision at the boundary only (§2.3).
 */
export function gateAutoApply(
  level: AutonomyLevel,
  nowMs: number,
  cfg: BusinessHoursConfig,
  teams: string[],
): AutoApplyRoute {
  if (!isAutoApply(level)) return 'auto-apply' // L0/L1 are not auto-apply; nothing to gate
  return isBusinessHours(nowMs, cfg, teams) ? 'auto-apply' : 'downgrade-to-PR'
}

/** Convenience helpers to build minutes-of-day without magic numbers in call sites. */
export const hm = (h: number, m = 0): number => h * 60 + m
