import { test, expect } from 'bun:test'
import { churnHold, DEFAULT_CHURN } from './src/index'

const H = 3_600_000
const now = 1_000_000_000_000 // fixed reference (no wall-clock reads)

test('no hold below the burst threshold', () => {
  expect(churnHold([], now)).toBe(false)
  expect(churnHold([now - H, now - 2 * H], now)).toBe(false) // only 2 < max 3
})

test('3 actions within a 6h window → held', () => {
  expect(churnHold([now - 5 * H, now - 4 * H, now - 3 * H], now)).toBe(true)
})

test('3 actions spread beyond a 6h window (no burst) → not held', () => {
  // consecutive span 11h > 6h — never 3 within a single 6h window
  expect(churnHold([now - 11 * H, now - 6 * H, now - 1 * H], now)).toBe(false)
})

test('a burst that has aged past the 12h quiet window → released', () => {
  expect(churnHold([now - 20 * H, now - 19 * H, now - 18 * H], now)).toBe(false)
})

test('config is the documented default (max 3 / 6h / 12h)', () => {
  expect(DEFAULT_CHURN).toEqual({ max: 3, windowH: 6, quietH: 12 })
})
