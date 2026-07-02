/**
 * @sho/pipeline — composition helpers that wire the product packages into one incident flow. The full
 * end-to-end walk (signal → dedup → RCA → deliver → route → gate → apply-write → trust → kill) lives in
 * pipeline.test.ts; these are the small deterministic glue functions that walk exercises.
 */

import { createHmac } from 'node:crypto'
import type { IncidentCandidate } from '@sho/contracts'
import { moduleArea, symptomSignature } from '@sho/aggregation'
import type { InMemoryIncidentMemory } from '@sho/incident-memory'
import { hm, type BusinessHoursConfig } from '@sho/hitl'

const DAY = 86_400_000

/** Sign a raw body the way @sho/signal-layer verifies it (HMAC-SHA256 hex over the raw bytes). */
export function signSignal(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex')
}

/** The class key the whole system routes on: (module_area, symptom_signature). Rename-proof. */
export function classKeyOf(c: IncidentCandidate): string {
  return `${moduleArea(c)}::${symptomSignature(c)}`
}

/**
 * Seed N confirmed-good LANDED resolutions for a class, applied long enough ago to have matured — the
 * accumulated outcome history that lets the router read a promoted level. Represents real history.
 */
export function seedConfirmedHistory(mem: InMemoryIncidentMemory, classKey: string, n: number, nowMs: number, ageDays = 40): void {
  const at = nowMs - ageDays * DAY
  for (let i = 0; i < n; i++) {
    mem.recordResolution({
      id: `res-${classKey}-${i}`,
      incidentId: `inc-${classKey}-${i}`,
      classKey,
      actionId: `act-${classKey}-${i}`,
      appliedAtMs: at,
      outcomeLabel: 'confirmed_good',
      rationaleText: 'confirmed good fix',
      createdAtMs: at,
    })
  }
}

/** A 7-day 09:00–19:00 UTC staffed window (weekday-independent so tests are robust). */
export const OFFICE_HOURS: BusinessHoursConfig = {
  teams: {
    checkout: { team: 'checkout', tzOffsetMin: 0, staffed: [{ days: [0, 1, 2, 3, 4, 5, 6], startMin: hm(9), endMin: hm(19) }], holidays: [] },
  },
  defaultPolicy: 'downgrade',
}
