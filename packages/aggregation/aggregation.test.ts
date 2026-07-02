import { test, expect } from 'bun:test'
import type { IncidentCandidate } from '@sho/contracts'
import {
  fingerprint,
  symptomSignature,
  moduleArea,
  errorSignature,
  stableHash,
  dedupe,
  priority,
  criticalityFromMap,
  defaultBlastRadius,
} from './src/index'

const NOW = Date.parse('2026-07-01T00:00:00.000Z')
const DAY = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString()

const cand = (over: Partial<IncidentCandidate> = {}): IncidentCandidate => ({
  id: 'i1',
  source: 'sentry',
  fingerprint: '',
  severity: 1,
  first_seen: iso(NOW),
  occurrences: 1,
  affected_service: 'checkout',
  affected_paths: ['src/checkout/pay.ts'],
  recent_deploys: [],
  shape: 'step',
  raw_payload: { error_class: 'TypeError', message: "cannot read 'total' of undefined", stack: [{ file: 'src/checkout/pay.ts', line: 42, function: 'charge' }] },
  ...over,
})

// ── fingerprint / signature ─────────────────────────────────────────────────

test('same stack → same fingerprint (identity is stable)', () => {
  const a = cand()
  const b = cand({ id: 'i2', occurrences: 9 }) // different id/occurrences, same source+paths+stack
  expect(fingerprint(a)).toBe(fingerprint(b))
})

test('a rename changes fingerprint but NOT symptomSignature (rename-proof key)', () => {
  const before = cand()
  const after = cand({
    affected_paths: ['src/checkout/payment.ts'], // renamed within the same module_area
    raw_payload: { error_class: 'TypeError', message: "cannot read 'total' of undefined", stack: [{ file: 'src/checkout/payment.ts', line: 47, function: 'charge' }] },
  })
  expect(fingerprint(after)).not.toBe(fingerprint(before)) // path moved → identity moved
  expect(symptomSignature(after)).toBe(symptomSignature(before)) // same module_area + error → same class
})

test('symptomSignature ignores volatile numbers/ids in the message', () => {
  const a = cand({ raw_payload: { error_class: 'DBError', message: 'timeout after 3000ms on conn 0xAB12' } })
  const b = cand({ raw_payload: { error_class: 'DBError', message: 'timeout after 5000ms on conn 0xFF99' } })
  expect(symptomSignature(a)).toBe(symptomSignature(b))
})

test('different module_area → different symptomSignature', () => {
  const a = cand({ affected_paths: ['src/checkout/pay.ts'] })
  const b = cand({ affected_paths: ['src/billing/pay.ts'] })
  expect(symptomSignature(a)).not.toBe(symptomSignature(b))
})

test('moduleArea = dir at depth 2 of first path; falls back to service', () => {
  expect(moduleArea(cand({ affected_paths: ['src/auth/login.ts'] }))).toBe('src/auth')
  expect(moduleArea(cand({ affected_paths: [], affected_service: 'svc-x' }))).toBe('svc-x')
  expect(moduleArea(cand({ affected_paths: ['top.ts'] }))).toBe('top.ts')
})

test('errorSignature is normalized text and stable-hashable', () => {
  expect(errorSignature(cand())).toContain('typeerror')
  expect(stableHash('x')).toBe(stableHash('x'))
  expect(stableHash('x')).not.toBe(stableHash('y'))
})

// ── dedupe ──────────────────────────────────────────────────────────────────

const opts = { minOccurrences: 3, windowMs: 7 * DAY, nowMs: NOW }

test('dedupe groups identical-stack candidates into one incident, summing occurrences', () => {
  const cs = [cand({ id: 'a', occurrences: 2 }), cand({ id: 'b', occurrences: 4 })]
  const out = dedupe(cs, opts)
  expect(out).toHaveLength(1)
  expect(out[0]!.occurrences).toBe(6)
  expect(out[0]!.suppressed).toBe(false) // 6 ≥ 3
})

test('dedupe merges a renamed variant via symptomSignature even though fingerprints differ', () => {
  const original = cand({ id: 'a', occurrences: 2 })
  const renamed = cand({
    id: 'b',
    occurrences: 3,
    affected_paths: ['src/checkout/payment.ts'],
    raw_payload: { error_class: 'TypeError', message: "cannot read 'total' of undefined", stack: [{ file: 'src/checkout/payment.ts', line: 47, function: 'charge' }] },
  })
  expect(fingerprint(original)).not.toBe(fingerprint(renamed))
  const out = dedupe([original, renamed], opts)
  expect(out).toHaveLength(1) // merged onto one class by the rename-proof key
  expect(out[0]!.occurrences).toBe(5)
})

test('dedupe keeps distinct classes separate', () => {
  const a = cand({ id: 'a', affected_paths: ['src/checkout/pay.ts'], raw_payload: { error_class: 'TypeError', message: 'boom' } })
  const b = cand({ id: 'b', affected_service: 'search', affected_paths: ['src/search/query.ts'], raw_payload: { error_class: 'RangeError', message: 'nope' } })
  const out = dedupe([a, b], opts)
  expect(out).toHaveLength(2)
})

test('dedupe suppresses noise below minOccurrences within the window', () => {
  const out = dedupe([cand({ occurrences: 2 })], opts) // 2 < 3
  expect(out).toHaveLength(1)
  expect(out[0]!.suppressed).toBe(true)
})

test('occurrences OUTSIDE the window do not count toward the noise floor', () => {
  const old = cand({ id: 'old', occurrences: 10, first_seen: iso(NOW - 30 * DAY) }) // outside 7d window
  const out = dedupe([old], opts)
  expect(out[0]!.occurrences).toBe(10) // total still summed
  expect(out[0]!.suppressed).toBe(true) // but nothing in-window → suppressed
})

test('dedupe uses earliest first_seen and max severity across the group', () => {
  const a = cand({ id: 'a', first_seen: iso(NOW - 2 * DAY), severity: 1, occurrences: 2 })
  const b = cand({ id: 'b', first_seen: iso(NOW - 5 * DAY), severity: 8, occurrences: 2 })
  const out = dedupe([a, b], opts)
  expect(out[0]!.first_seen).toBe(iso(NOW - 5 * DAY))
  expect(out[0]!.severity).toBe(8)
})

test('dedupe is order-independent', () => {
  const a = cand({ id: 'a', occurrences: 2 })
  const b = cand({ id: 'b', affected_service: 'search', affected_paths: ['src/search/q.ts'], raw_payload: { error_class: 'RangeError', message: 'x' }, occurrences: 5 })
  const f = (cs: IncidentCandidate[]) => dedupe(cs, opts).map((i) => [i.fingerprint, i.occurrences])
  expect(f([a, b])).toEqual(f([b, a]))
})

// ── priority ──────────────────────────────────────────────────────────────────

const crit = criticalityFromMap({ checkout: 5, search: 1 }, 2)

test('priority = blast_radius × frequency × business_criticality', () => {
  const c = cand({ affected_paths: ['a.ts', 'b.ts', 'c.ts'], occurrences: 4, affected_service: 'checkout' })
  // blast 3 × freq 4 × crit 5 = 60
  expect(priority(c, { businessCriticality: crit })).toBe(60)
})

test('priority uses the injected businessCriticality map (unknown service → fallback)', () => {
  const c = cand({ affected_paths: ['a.ts'], occurrences: 1, affected_service: 'ghost' })
  expect(priority(c, { businessCriticality: crit })).toBe(2) // 1×1×fallback(2)
})

test('priority honors an injected blastRadius fn', () => {
  const c = cand({ affected_paths: ['a.ts'], occurrences: 1, affected_service: 'search' })
  expect(priority(c, { businessCriticality: crit, blastRadius: () => 10 })).toBe(10) // 10×1×1
})

test('defaultBlastRadius floors at 1 even with no paths', () => {
  expect(defaultBlastRadius(cand({ affected_paths: [] }))).toBe(1)
})

test('priority ordering: high-criticality high-frequency wins', () => {
  const hot = cand({ id: 'hot', affected_service: 'checkout', affected_paths: ['a.ts', 'b.ts'], occurrences: 10 }) // 2×10×5 = 100
  const warm = cand({ id: 'warm', affected_service: 'search', affected_paths: ['a.ts', 'b.ts'], occurrences: 10 }) // 2×10×1 = 20
  const cold = cand({ id: 'cold', affected_service: 'search', affected_paths: ['a.ts'], occurrences: 1 }) // 1×1×1 = 1
  const ranked = [cold, hot, warm].sort((x, y) => priority(y, { businessCriticality: crit }) - priority(x, { businessCriticality: crit }))
  expect(ranked.map((c) => c.id)).toEqual(['hot', 'warm', 'cold'])
})
