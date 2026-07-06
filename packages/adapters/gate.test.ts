import { test, expect } from 'bun:test'
import { toContractsGate } from './src/index'
import type { GateResult as RichGateResult } from '../../gate/verify'

const richPass: RichGateResult = {
  pass: true,
  context: { loop: 'C', tier: 2, moduleArea: 'src/checkout' },
  signals: {
    mustFailOnParent: { pass: true, code: 'DISCRIMINATING', reason: 'test fails on parent, passes on fix' },
    mutationScore: { pass: true, score: 0.82, threshold: 0.6, killed: 9, total: 11, survivors: [] },
    noWeakening: { pass: true, reason: 'ok' },
    diffLines: 6,
    exceedsClassBudget: false,
  },
  reason: 'PASS — all hard gates green',
}

const ctx = { moduleArea: 'src/checkout', autonomy: { level: 'L1' as const, tier: 2 as const, requiredMutationScore: 0.6, accountableOwner: 'o' } }

test('maps a rich passing gate to the contracts shape (loop C, resolved tier)', () => {
  const c = toContractsGate(richPass, ctx)
  expect(c.pass).toBe(true)
  expect(c.loop).toBe('C')
  expect(c.tier).toBe(2)
  expect(c.moduleArea).toBe('src/checkout')
  expect(c.signals.mustFailOnParent).toEqual({ pass: true, code: 'DISCRIMINATING' })
  expect(c.signals.mutationScore).toEqual({ pass: true, score: 0.82, threshold: 0.6 })
  expect(c.signals.noWeakening).toEqual({ pass: true })
  expect(c.signals.diffLines).toBe(6)
})

test('a rejecting gate maps its failure through (mutation below bar, null no-weakening)', () => {
  const richFail: RichGateResult = {
    ...richPass,
    pass: false,
    signals: { ...richPass.signals, mutationScore: { pass: false, score: 0.4, threshold: 0.6, killed: 4, total: 10, survivors: [{ line: 12, op: 'cond' }] }, noWeakening: null },
    reason: 'REJECT — mutation score 0.40<0.6',
  }
  const c = toContractsGate(richFail, ctx)
  expect(c.pass).toBe(false)
  expect(c.signals.mutationScore.pass).toBe(false)
  expect(c.signals.mutationScore.score).toBe(0.4)
  expect(c.signals.noWeakening).toBeNull()
  expect(c.reason).toContain('REJECT')
})
