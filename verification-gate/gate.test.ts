import { test, expect } from 'bun:test'
import { mustFailOnParent, noWeakening } from './gate'

const O = (failed: number, ran = true) => ({ ran, failed, passed: failed === 0 ? 1 : 0 })

test('DISCRIMINATING: fails on parent, passes on fix', () => {
  const v = mustFailOnParent(O(1), O(0))
  expect(v.pass).toBe(true)
  expect(v.code).toBe('DISCRIMINATING')
})

test('VACUOUS: passes on parent → rejected (attack #4)', () => {
  const v = mustFailOnParent(O(0), O(0))
  expect(v.pass).toBe(false)
  expect(v.code).toBe('VACUOUS')
})

test('UNFIXED: still fails on fix → rejected', () => {
  const v = mustFailOnParent(O(1), O(1))
  expect(v.pass).toBe(false)
  expect(v.code).toBe('UNFIXED')
})

test('INFRA: did not run → rejected, not a pass', () => {
  const v = mustFailOnParent({ ran: false, failed: 0, passed: 0 }, O(0))
  expect(v.pass).toBe(false)
  expect(v.code).toBe('INFRA')
})

test('no-weakening: new test passes trivially', () => {
  expect(noWeakening(undefined, 'expect(x).toBe(5)').pass).toBe(true)
})

test('no-weakening: strong→weak heal is rejected', () => {
  const parent = 'expect(total).toBe(90)'
  const fix = 'expect(total).not.toBeNull()'
  const v = noWeakening(parent, fix)
  expect(v.pass).toBe(false)
  expect(v.strongParent).toBe(1)
  expect(v.strongFix).toBe(0)
})

test('no-weakening: equal-or-stronger heal passes', () => {
  const parent = 'expect(a).toBe(1)'
  const fix = 'expect(a).toBe(1); expect(b).toEqual([2,3])'
  expect(noWeakening(parent, fix).pass).toBe(true)
})
