import { test, expect } from 'bun:test'
import { combineGate, mergeReports } from './verify'
import type { GateVerdict } from '../verification-gate/gate'
import type { ScoreReport } from '../mutation-gate/gate'

const mf = (pass: boolean, code = pass ? 'DISCRIMINATING' : 'VACUOUS'): GateVerdict => ({
  gate: 'must-fail-on-parent', pass, code: code as any, reason: code,
  parent: { ran: true, failed: pass ? 1 : 0, passed: 0 }, fix: { ran: true, failed: 0, passed: 1 },
})
const mut = (score: number | null, threshold = 0.75): ScoreReport => ({
  total: 10, killed: score === null ? 0 : Math.round(score * 10), survived: score === null ? 0 : 10 - Math.round(score * 10),
  score, threshold, pass: score !== null && score >= threshold, reason: '', survivors: [],
})

test('all green → pass', () => {
  const g = combineGate({ mustFail: mf(true), mutation: mut(1.0), noWeakening: null, diffLines: 8, classDiffBudget: 15, moduleArea: 'src/checkout' })
  expect(g.pass).toBe(true)
  expect(g.signals.exceedsClassBudget).toBe(false)
})

test('vacuous test → reject even if mutation passes', () => {
  const g = combineGate({ mustFail: mf(false), mutation: mut(1.0), noWeakening: null, diffLines: 8, classDiffBudget: 15, moduleArea: 'src/x' })
  expect(g.pass).toBe(false)
  expect(g.reason).toContain('must-fail-on-parent')
})

test('weak suite → reject even if the test discriminates', () => {
  const g = combineGate({ mustFail: mf(true), mutation: mut(0.1), noWeakening: null, diffLines: 8, classDiffBudget: 15, moduleArea: 'src/x' })
  expect(g.pass).toBe(false)
  expect(g.reason).toContain('mutation score')
})

test('weakened heal → reject', () => {
  const g = combineGate({ mustFail: mf(true), mutation: mut(1.0), noWeakening: { pass: false, reason: 'loosened' }, diffLines: 8, classDiffBudget: 15, moduleArea: 'src/x' })
  expect(g.pass).toBe(false)
  expect(g.reason).toContain('no-weakening')
})

test('exceeds class budget is a SIGNAL, not a hard fail', () => {
  const g = combineGate({ mustFail: mf(true), mutation: mut(1.0), noWeakening: null, diffLines: 40, classDiffBudget: 15, moduleArea: 'src/x' })
  expect(g.pass).toBe(true) // still passes the hard gates
  expect(g.signals.exceedsClassBudget).toBe(true)
  expect(g.reason).toContain('churn signal')
})

test('mergeReports aggregates score across files', () => {
  const a: ScoreReport = { total: 4, killed: 4, survived: 0, score: 1, threshold: 0.75, pass: true, reason: '', survivors: [] }
  const b: ScoreReport = { total: 6, killed: 2, survived: 4, score: 0.33, threshold: 0.75, pass: false, reason: '', survivors: [{ line: 3, op: '+→-' }, { line: 5, op: '>→<' }, { line: 6, op: '&&→||' }, { line: 7, op: '<→>' }] }
  const m = mergeReports([a, b], 0.75)
  expect(m.total).toBe(10)
  expect(m.killed).toBe(6)
  expect(m.score).toBe(0.6)
  expect(m.pass).toBe(false)
})
