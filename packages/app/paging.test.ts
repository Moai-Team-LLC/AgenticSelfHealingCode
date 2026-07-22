import { test, expect } from 'bun:test'
import type { UpstreamDiagnosis } from '@sho/aggregation'
import { shouldPage, isActionable, PageDedup } from './src/index'

const billing: UpstreamDiagnosis = { cls: 'billing', cause: 'credit exhausted', action: 'top up', actionable: true }
const transient: UpstreamDiagnosis = { cls: 'provider_outage', cause: 'outage', action: 'wait', actionable: false }

test('isActionable: CONFIRMED, suspicious, and actionable upstream all need a human', () => {
  expect(isActionable({ gate: 'CONFIRMED', suspicious: false, occurrences: 1, upstream: null })).toBe(true)
  expect(isActionable({ gate: 'ESCALATE', suspicious: true, occurrences: 1, upstream: null })).toBe(true)
  expect(isActionable({ gate: 'ESCALATE', suspicious: false, occurrences: 1, upstream: billing })).toBe(true)
  expect(isActionable({ gate: 'ESCALATE', suspicious: false, occurrences: 1, upstream: transient })).toBe(false)
  expect(isActionable({ gate: 'ESCALATE', suspicious: false, occurrences: 1, upstream: null })).toBe(false)
})

test('noise floor: a single-occurrence transient/unknown ESCALATE does NOT page', () => {
  expect(shouldPage({ gate: 'ESCALATE', suspicious: false, occurrences: 1, upstream: transient })).toBe(false)
  expect(shouldPage({ gate: 'ESCALATE', suspicious: false, occurrences: 1, upstream: null })).toBe(false)
})

test('a recurring transient (occurrences over the floor) DOES page', () => {
  expect(shouldPage({ gate: 'ESCALATE', suspicious: false, occurrences: 2, upstream: transient })).toBe(true)
})

test('actionable things page on the FIRST occurrence (they never self-resolve)', () => {
  expect(shouldPage({ gate: 'ESCALATE', suspicious: false, occurrences: 1, upstream: billing })).toBe(true)
  expect(shouldPage({ gate: 'CONFIRMED', suspicious: false, occurrences: 1, upstream: null })).toBe(true)
  expect(shouldPage({ gate: 'ESCALATE', suspicious: true, occurrences: 1, upstream: null })).toBe(true)
})

test('PageDedup: the same fingerprint pages once per window, then again after it', () => {
  const d = new PageDedup(1000) // 1s window
  const t0 = 100_000
  expect(d.suppressed('fp', t0)).toBe(false)
  d.markPaged('fp', t0)
  expect(d.suppressed('fp', t0 + 500)).toBe(true) // within the window
  expect(d.suppressed('fp', t0 + 1500)).toBe(false) // window elapsed
  expect(d.suppressed('other', t0 + 500)).toBe(false) // a different cause is unaffected
})
