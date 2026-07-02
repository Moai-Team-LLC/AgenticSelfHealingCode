/**
 * PagerDuty incidents → IncidentRecord adapter (representative API-shape adapter).
 *
 * PagerDuty knows detection/ack/resolve but NOT cause_confirmed_at or fix_deployed_at — so those stay
 * undefined and the D10 tool honestly reports the incident as non-decomposable (no_cause_ts) until you
 * enrich it (adapters/enrich.ts) or add a root-cause timestamp to your process. That honesty is the
 * point: most trackers are detection tools, not lifecycle tools. Other API trackers (Opsgenie, Linear,
 * ServiceNow) follow the same shape — map their native fields to the contract here.
 *
 * Input: the array from `GET /incidents?include[]=log_entries` (or an export of the same shape).
 */

import type { IncidentRecord } from '../d10'

interface PDLogEntry { type?: string; created_at?: string }
interface PDIncident {
  id?: string
  incident_number?: number
  created_at?: string
  resolved_at?: string
  urgency?: string
  service?: { summary?: string }
  log_entries?: PDLogEntry[]
  // optional custom field carrying resolution classification, if your org sets one
  resolution_type?: string
}

function firstOfType(logs: PDLogEntry[] | undefined, type: string): string | undefined {
  return logs?.find((l) => l.type === type)?.created_at
}

export function pagerDutyToIncidents(incidents: PDIncident[]): IncidentRecord[] {
  return incidents.map((i) => {
    const rec: IncidentRecord = {
      id: i.id ?? String(i.incident_number ?? ''),
      detected_at: i.created_at,
    }
    if (i.service?.summary) rec.service = i.service.summary
    const ack = firstOfType(i.log_entries, 'acknowledge_log_entry')
    if (ack) rec.acknowledged_at = ack
    const resolved = i.resolved_at ?? firstOfType(i.log_entries, 'resolve_log_entry')
    if (resolved) rec.resolved_at = resolved
    if (i.resolution_type) rec.resolution_type = i.resolution_type
    // cause_confirmed_at and fix_deployed_at are intentionally absent — PagerDuty does not record them.
    return rec
  })
}
