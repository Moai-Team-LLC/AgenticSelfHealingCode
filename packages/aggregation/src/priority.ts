/**
 * Priority scoring (ARCH-ORIG §3): priority = blast_radius × frequency × business_criticality.
 * Fully deterministic. The two policy inputs are INJECTED so the layer stays pure and testable:
 *   - businessCriticality(service) → weight (a per-service map; missing service = default weight);
 *   - blastRadius(candidate) → how many things a failure touches (default: affected_paths count).
 * Frequency comes from the candidate's own occurrences count. Higher score = fix sooner.
 */

import type { IncidentCandidate } from '@sho/contracts'

export type BusinessCriticality = (service: string) => number
export type BlastRadius = (candidate: IncidentCandidate) => number

export interface PriorityOptions {
  businessCriticality: BusinessCriticality
  blastRadius?: BlastRadius // default: number of affected paths (min 1)
}

/** Default blast radius = count of affected paths, floored at 1 (an incident always touches ≥1 thing). */
export const defaultBlastRadius: BlastRadius = (c) => Math.max(1, c.affected_paths.length)

/** Build a businessCriticality fn from a plain service→weight map with a default for unknown services. */
export function criticalityFromMap(map: Record<string, number>, fallback = 1): BusinessCriticality {
  return (service) => {
    const w = map[service]
    return typeof w === 'number' && Number.isFinite(w) ? w : fallback
  }
}

export function priority(candidate: IncidentCandidate, opts: PriorityOptions): number {
  const blast = (opts.blastRadius ?? defaultBlastRadius)(candidate)
  const frequency = Math.max(1, candidate.occurrences)
  const crit = opts.businessCriticality(candidate.affected_service)
  return blast * frequency * crit
}
