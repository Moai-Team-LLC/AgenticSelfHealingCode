/**
 * Enrichment — fill fix_deployed_at (and optionally cause_confirmed_at) from sources the incident
 * tracker lacks. This is what makes REMEDIATION measurable: most trackers record detection/ack/resolve
 * but not when the fix actually shipped. The deploy log and git history know that.
 *
 * Pure functions; no I/O. Feed them parsed deploy records or `git log` output.
 */

import type { IncidentRecord } from '../d10'

// ---- deploy-log enrichment -----------------------------------------------

export interface DeployRecord {
  deployed_at: string // ISO
  incident_ids?: string[] // incidents this deploy fixed (explicit linkage — deterministic)
}

/**
 * Set fix_deployed_at to the EARLIEST deploy that references the incident id. Explicit linkage only
 * (a deploy lists the incidents it fixed) — no fuzzy time-window guessing, which would fabricate data.
 * Never overwrites an existing fix_deployed_at.
 */
export function enrichWithDeploys(records: IncidentRecord[], deploys: DeployRecord[]): IncidentRecord[] {
  const byIncident = new Map<string, number>() // incident id → earliest deploy ms
  for (const d of deploys) {
    const ms = Date.parse(d.deployed_at)
    if (!Number.isFinite(ms)) continue
    for (const id of d.incident_ids ?? []) {
      const prev = byIncident.get(id)
      if (prev === undefined || ms < prev) byIncident.set(id, ms)
    }
  }
  return records.map((r) => {
    if (r.fix_deployed_at) return r
    const ms = byIncident.get(r.id)
    return ms === undefined ? r : { ...r, fix_deployed_at: new Date(ms).toISOString() }
  })
}

// ---- git-history enrichment ----------------------------------------------

export interface GitCommit { at: string; message: string } // parsed from `git log --format=%cI%x09%s`

/**
 * Parse `git log --format=%cI%x09%s` output (committer-date ISO <TAB> subject) into commits.
 */
export function parseGitLog(text: string): GitCommit[] {
  const out: GitCommit[] = []
  for (const line of text.split('\n')) {
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    out.push({ at: line.slice(0, tab).trim(), message: line.slice(tab + 1) })
  }
  return out
}

/**
 * Set fix_deployed_at from the EARLIEST commit whose message references the incident id via `idPattern`
 * (a function producing the per-incident matcher — e.g. `(id) => new RegExp(\`\\b${id}\\b\`)` or your
 * "Fixes INC-123" convention). A commit is a proxy for "fix landed"; prefer a real deploy log when you
 * have one (enrichWithDeploys). Never overwrites an existing fix_deployed_at.
 */
export function enrichWithGit(
  records: IncidentRecord[],
  commits: GitCommit[],
  idPattern: (id: string) => RegExp,
): IncidentRecord[] {
  return records.map((r) => {
    if (r.fix_deployed_at) return r
    const re = idPattern(r.id)
    let earliest: number | undefined
    for (const c of commits) {
      if (!re.test(c.message)) continue
      const ms = Date.parse(c.at)
      if (Number.isFinite(ms) && (earliest === undefined || ms < earliest)) earliest = ms
    }
    return earliest === undefined ? r : { ...r, fix_deployed_at: new Date(earliest).toISOString() }
  })
}
