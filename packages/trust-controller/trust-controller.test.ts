import { test, expect } from 'bun:test'
import type { OutcomeEvent, OutcomeEventKind } from '@sho/contracts'
import { effectiveLevel, requiredMutationScore, harmCount, foldClass } from './src/index'

const DAY = 86_400_000
const NOW = Date.parse('2026-07-01T00:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
let seq = 0
const ev = (kind: OutcomeEventKind, atMs: number): OutcomeEvent => ({ actionId: `a${seq++}`, kind, at: iso(atMs) })
const many = (kind: OutcomeEventKind, n: number, atMs: number) => Array.from({ length: n }, () => ev(kind, atMs))

const applied60d = ev('applied', NOW - 60 * DAY)

test('base: no outcomes → L1 (nothing auto by default)', () => {
  expect(effectiveLevel([], NOW).level).toBe('L1')
})

test('low override alone never promotes — applied but zero confirmed-good stays L1 (D6)', () => {
  const r = effectiveLevel([applied60d], NOW)
  expect(r.level).toBe('L1')
  expect(r.stats.confirmedGood).toBe(0)
})

test('30 confirmed-good, clean, dwelled → L2', () => {
  const r = effectiveLevel([applied60d, ...many('matured', 30, NOW - 30 * DAY)], NOW)
  expect(r.level).toBe('L2')
})

test('100 confirmed-good, clean, dwelled ≥45d → L3', () => {
  const r = effectiveLevel([applied60d, ...many('matured', 100, NOW - 50 * DAY)], NOW)
  expect(r.level).toBe('L3')
})

test('a single recent caused-incident collapses an L3-worthy class to L1 (fast demote, asymmetry)', () => {
  const events = [applied60d, ...many('matured', 100, NOW - 50 * DAY), ev('revert', NOW - 5 * DAY)]
  const r = effectiveLevel(events, NOW)
  expect(r.level).toBe('L1')
  expect(r.reason).toContain('fast demote')
})

test('rate gate: enough confirmed-good but rate < θ → held at L1', () => {
  // 30 matured + 3 caused (old, outside the recent window) → rate 0.909 < 0.98
  const events = [applied60d, ...many('matured', 30, NOW - 30 * DAY), ...many('spawn', 3, NOW - 40 * DAY)]
  const r = effectiveLevel(events, NOW)
  expect(r.stats.confirmedGoodRate).toBeCloseTo(0.909, 2)
  expect(r.level).toBe('L1')
})

test('kill switch forces L0 regardless of evidence', () => {
  const events = [applied60d, ...many('matured', 100, NOW - 50 * DAY)]
  expect(effectiveLevel(events, NOW, { killed: true }).level).toBe('L0')
})

test('harmCount + requiredMutationScore', () => {
  expect(harmCount([ev('recurrence', NOW), ev('spawn', NOW), ev('matured', NOW)])).toBe(2)
  expect(requiredMutationScore('L1')).toBe(0.6)
  expect(requiredMutationScore('L2')).toBe(0.75)
  expect(requiredMutationScore('L3')).toBe(0.8)
})

test('fold aggregates are order-independent', () => {
  const a = foldClass([ev('matured', NOW), ev('applied', NOW - DAY), ev('revert', NOW)])
  expect(a.confirmedGood).toBe(1)
  expect(a.caused).toBe(1)
  expect(a.applied).toBe(1)
})
