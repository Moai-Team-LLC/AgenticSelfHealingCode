/**
 * Sentry → IncidentRecord adapter.
 *
 * Sentry is a DETECTION tool: it knows when an issue was first/last seen and where, but not when a
 * human acknowledged it, confirmed the cause, or shipped the fix. So this adapter fills detected_at
 * (and service), and leaves the lifecycle fields undefined — D10 then reports Sentry-only incidents as
 * non-decomposable, which is the truth. Sentry pairs with Linear (workflow timestamps) and a deploy
 * log (adapters/enrich.ts, fix_deployed_at); it is not a standalone MTTR source.
 *
 * Pure over the Sentry issues REST shape; connectors/sentry-pull.ts fetches it.
 */

import type { IncidentRecord } from '../d10'

export interface SentryIssue {
  id?: string
  shortId?: string
  title?: string
  culprit?: string
  firstSeen?: string
  lastSeen?: string
  status?: string
  project?: { slug?: string } | null
}

export function sentryToIncidents(issues: SentryIssue[]): IncidentRecord[] {
  return issues
    .map((i) => {
      const rec: IncidentRecord = { id: i.shortId ?? i.id ?? '' }
      if (i.project?.slug) rec.service = i.project.slug
      if (i.firstSeen) rec.detected_at = i.firstSeen
      // acknowledged_at / cause_confirmed_at / fix_deployed_at / resolved_at: Sentry does not record
      // them. Left undefined on purpose — do NOT map lastSeen to resolved_at (last event ≠ resolution).
      return rec
    })
    .filter((r) => r.id)
}
