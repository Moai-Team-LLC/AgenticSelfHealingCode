/**
 * CSV → IncidentRecord adapter (universal: every tracker exports CSV).
 *
 * Maps columns to the D10 contract by header name, with common aliases, case-insensitive. Whatever
 * timestamps your export lacks stay undefined — the D10 tool then reports them as excluded/low-confidence
 * rather than inventing them. Combine with adapters/enrich.ts to fill fix_deployed_at from a deploy log.
 */

import type { IncidentRecord } from '../d10'

// contract field → accepted header aliases (lowercased)
const ALIASES: Record<keyof IncidentRecord, string[]> = {
  id: ['id', 'incident_id', 'number', 'key', 'ref'],
  service: ['service', 'component', 'team', 'project', 'affected_service'],
  detected_at: ['detected_at', 'created_at', 'first_seen', 'firstseen', 'opened_at', 'started_at'],
  acknowledged_at: ['acknowledged_at', 'ack_at', 'acknowledged', 'triaged_at'],
  cause_confirmed_at: ['cause_confirmed_at', 'root_cause_at', 'rca_at', 'diagnosed_at', 'cause_at'],
  fix_deployed_at: ['fix_deployed_at', 'deployed_at', 'fixed_at', 'fix_at', 'mitigated_at'],
  resolved_at: ['resolved_at', 'closed_at', 'resolved', 'recovered_at'],
  resolution_type: ['resolution_type', 'resolution', 'type', 'category'],
}

/** Minimal RFC-4180-ish CSV parser: quoted fields, embedded commas/quotes/newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else inQuotes = false
      } else field += c
    } else if (c === '"') inQuotes = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.length > 1 || row[0] !== '') rows.push(row)
      row = []
    } else field += c
  }
  if (field !== '' || row.length) { row.push(field); if (row.length > 1 || row[0] !== '') rows.push(row) }
  return rows
}

function buildColumnMap(header: string[]): Partial<Record<keyof IncidentRecord, number>> {
  const norm = header.map((h) => h.trim().toLowerCase())
  const map: Partial<Record<keyof IncidentRecord, number>> = {}
  for (const field of Object.keys(ALIASES) as (keyof IncidentRecord)[]) {
    const idx = norm.findIndex((h) => ALIASES[field].includes(h))
    if (idx >= 0) map[field] = idx
  }
  return map
}

export function csvToIncidents(csvText: string): IncidentRecord[] {
  const rows = parseCsv(csvText)
  if (rows.length < 2) return []
  const [header, ...body] = rows
  const cols = buildColumnMap(header)
  if (cols.id === undefined) throw new Error('CSV has no id/incident_id/number column')
  const out: IncidentRecord[] = []
  for (const r of body) {
    const rec: IncidentRecord = { id: (r[cols.id!] ?? '').trim() }
    for (const field of Object.keys(cols) as (keyof IncidentRecord)[]) {
      if (field === 'id') continue
      const v = (r[cols[field]!] ?? '').trim()
      if (v !== '') (rec as any)[field] = v
    }
    if (rec.id) out.push(rec)
  }
  return out
}
