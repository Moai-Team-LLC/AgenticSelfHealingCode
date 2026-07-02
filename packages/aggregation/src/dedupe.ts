/**
 * Dedup / noise-suppression (ARCH-ORIG §3). Collapse a stream of candidates into distinct incidents,
 * grouping by fingerprint OR symptomSignature (union-find over both keys — so a renamed variant with a
 * fresh fingerprint still merges onto the same class via its rename-proof signature), then suppress any
 * incident that hasn't cleared the noise floor: < minOccurrences events inside windowMs.
 * Pure and deterministic — the caller supplies `nowMs`.
 */

import type { IncidentCandidate } from '@sho/contracts'
import { fingerprint, moduleArea, symptomSignature } from './signature'

/** Aggregation-local incident shape (maps to incident_memory.incidents columns; not a shared type). */
export interface Incident {
  fingerprint: string
  symptom_signature: string
  module_area: string
  affected_service: string
  first_seen: string // ISO — earliest across the group
  occurrences: number // summed across the group
  severity: number // max across the group
  candidates: IncidentCandidate[]
  suppressed: boolean // below the noise floor within the window
}

export interface DedupeOptions {
  minOccurrences: number // noise floor: distinct incident must reach this many events…
  windowMs: number // …within this trailing window (measured from nowMs)
  nowMs: number
}

const parseMs = (iso: string): number => {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : 0
}

/**
 * Merge candidates into incidents. Two candidates land in the same incident if they share a fingerprint
 * or a symptomSignature. Occurrences are summed; first_seen is the earliest; severity is the max. An
 * incident is `suppressed` when its in-window occurrences are below `minOccurrences`.
 */
export function dedupe(candidates: IncidentCandidate[], opts: DedupeOptions): Incident[] {
  // Union-find keyed by string labels (both fingerprint and symptom keys share the same DSU).
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let r = x
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r) as string
    if (parent.get(x) === undefined) parent.set(x, x)
    let c = x
    while (parent.get(c) !== undefined && parent.get(c) !== c) {
      const next = parent.get(c) as string
      parent.set(c, r)
      c = next
    }
    return r
  }
  const union = (a: string, b: string) => {
    const ra = find(a), rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  const fpOf = new Map<IncidentCandidate, string>()
  const sigOf = new Map<IncidentCandidate, string>()
  for (const c of candidates) {
    const fp = 'fp:' + fingerprint(c)
    const sig = 'sig:' + symptomSignature(c)
    fpOf.set(c, fp)
    sigOf.set(c, sig)
    find(fp)
    find(sig)
    union(fp, sig) // the two keys of one candidate are the same class
  }

  // Bucket candidates by their union-find root.
  const groups = new Map<string, IncidentCandidate[]>()
  for (const c of candidates) {
    const root = find(fpOf.get(c) as string)
    const g = groups.get(root)
    if (g) g.push(c)
    else groups.set(root, [c])
  }

  const windowStart = opts.nowMs - opts.windowMs
  const incidents: Incident[] = []
  for (const g of groups.values()) {
    let first = Infinity
    let occurrences = 0
    let inWindow = 0
    let severity = -Infinity
    for (const c of g) {
      const seen = parseMs(c.first_seen)
      first = Math.min(first, seen)
      occurrences += c.occurrences
      if (seen >= windowStart) inWindow += c.occurrences
      severity = Math.max(severity, c.severity)
    }
    // Representative = earliest-seen candidate (stable identity for the incident's keys).
    const rep = [...g].sort((a, b) => parseMs(a.first_seen) - parseMs(b.first_seen))[0] as IncidentCandidate
    incidents.push({
      fingerprint: fingerprint(rep),
      symptom_signature: symptomSignature(rep),
      module_area: moduleArea(rep),
      affected_service: rep.affected_service,
      first_seen: new Date(first === Infinity ? opts.nowMs : first).toISOString(),
      occurrences,
      severity: severity === -Infinity ? 0 : severity,
      candidates: g,
      suppressed: inWindow < opts.minOccurrences,
    })
  }

  // Deterministic order: most occurrences first, then earliest, then fingerprint.
  incidents.sort(
    (a, b) =>
      b.occurrences - a.occurrences ||
      parseMs(a.first_seen) - parseMs(b.first_seen) ||
      a.fingerprint.localeCompare(b.fingerprint),
  )
  return incidents
}
