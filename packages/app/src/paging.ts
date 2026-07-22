/**
 * The paging decision — fights alert fatigue. Two independent silencers on top of the durable notify CAS:
 *   1. NOISE FLOOR — a single-occurrence, non-actionable ESCALATE (a transient provider blip that self-resolved,
 *      no deploy, unconfirmed cause) does not page a human. It is still recorded; it just stays quiet unless it
 *      recurs (occurrences reach the floor). An *actionable* escalation (billing/auth) or a CONFIRMED verdict
 *      pages even on the first occurrence — those do not fix themselves.
 *   2. FINGERPRINT DEDUP — the same cause (fingerprint) pages at most once per window, so one provider outage
 *      that throws N times is one page, not N. (The notify CAS dedups a single incident id; this dedups a cause
 *      across many incident ids.)
 */

import type { UpstreamDiagnosis } from '@sho/aggregation'

export interface PagingConfig {
  /** page a non-actionable ESCALATE only once occurrences reach this (default 2 → a single spike stays quiet). */
  noiseFloorOccurrences: number
  /** the same fingerprint pages at most once per this window (ms). */
  dedupWindowMs: number
}

export const DEFAULT_PAGING: PagingConfig = { noiseFloorOccurrences: 2, dedupWindowMs: 15 * 60_000 }

export interface PagingInput {
  gate: 'CONFIRMED' | 'ESCALATE'
  suspicious: boolean
  occurrences: number
  upstream: UpstreamDiagnosis | null
}

/** Does this incident need a human to DO something? (drives whether it pages on a single occurrence + the ack button) */
export function isActionable(input: PagingInput): boolean {
  return input.gate === 'CONFIRMED' || input.suspicious || (input.upstream?.actionable ?? false)
}

/** The noise floor: should this incident page at all (before the per-fingerprint dedup window)? */
export function shouldPage(input: PagingInput, cfg: PagingConfig = DEFAULT_PAGING): boolean {
  if (isActionable(input)) return true // CONFIRMED / suspicious / billing / auth — never self-resolves
  return input.occurrences >= cfg.noiseFloorOccurrences // non-actionable ESCALATE: only once it recurs
}

/** Per-fingerprint dedup window: the same cause pages at most once per window. In-memory (a ring of live causes). */
export class PageDedup {
  private readonly lastPagedMs = new Map<string, number>()
  constructor(private readonly windowMs: number = DEFAULT_PAGING.dedupWindowMs) {}

  /** True iff this fingerprint was paged within the window and should be suppressed now. */
  suppressed(fingerprint: string, nowMs: number): boolean {
    const last = this.lastPagedMs.get(fingerprint)
    return last !== undefined && nowMs - last < this.windowMs
  }
  markPaged(fingerprint: string, nowMs: number): void {
    this.lastPagedMs.set(fingerprint, nowMs)
  }
}
