import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { analyze, decompose, median, label, DEFAULT_CFG, type IncidentRecord } from './d10'

const sample: IncidentRecord[] = JSON.parse(readFileSync(new URL('./fixtures/incidents.sample.json', import.meta.url), 'utf8'))

test('median handles odd/even/empty', () => {
  expect(median([])).toBeNull()
  expect(median([5])).toBe(5)
  expect(median([1, 3])).toBe(2)
  expect(median([3, 1, 2])).toBe(2)
})

test('label thresholds', () => {
  expect(label(0.8, DEFAULT_CFG)).toBe('diagnosis-heavy')
  expect(label(0.6, DEFAULT_CFG)).toBe('diagnosis-heavy')
  expect(label(0.5, DEFAULT_CFG)).toBe('mixed')
  expect(label(0.4, DEFAULT_CFG)).toBe('remediation-heavy')
  expect(label(null, DEFAULT_CFG)).toBe('insufficient-data')
})

test('decompose separates the messy records with correct reasons', () => {
  const { decomposed, excluded } = decompose(sample)
  expect(decomposed.length).toBe(11)
  expect(excluded.length).toBe(3)
  const reasons = Object.fromEntries(excluded.map((e) => [e.id, e.reason]))
  expect(reasons['missing-cause-1']).toBe('no_cause_ts')
  expect(reasons['bad-order-1']).toBe('nonpositive_span')
  expect(reasons['no-action-1']).toBe('no_fix_ts')
})

test('sample is diagnosis-heavy overall, with per-class nuance', () => {
  const a = analyze(sample, DEFAULT_CFG)
  expect(a.verdict).toBe('diagnosis-heavy')
  expect(a.medianDiagnosisShare).toBeCloseTo(0.78, 2)
  // per-class: payments is remediation-heavy, checkout/api diagnosis-heavy
  const byCls = Object.fromEntries(a.classes.map((c) => [c.cls, c.verdict]))
  expect(byCls['payments']).toBe('remediation-heavy')
  expect(byCls['checkout']).toBe('diagnosis-heavy')
})

test('loop-C addressability: code-fix remediation median and rollback share', () => {
  const a = analyze(sample, DEFAULT_CFG)
  expect(a.loopCAddressable.codeFixCount).toBe(10)
  expect(a.loopCAddressable.codeFixMedianRemediationMin).toBe(15)
  expect(a.loopCAddressable.rollbackShare).toBeCloseTo(0.09, 2)
})
