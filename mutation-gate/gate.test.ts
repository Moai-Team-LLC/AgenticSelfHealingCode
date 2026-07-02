import { test, expect } from 'bun:test'
import { mutate, maskLine, scoreGate, type MutantResult } from './gate'

test('maskLine blanks strings and comments, keeps real operators', () => {
  expect(maskLine('const x = a > b // > not this')).toContain('a > b')
  expect(maskLine('const s = "a > b"').includes('>')).toBe(false)
  expect(maskLine('x + y // + z').trimEnd()).toBe('x + y')
})

test('mutate produces one mutant per operator occurrence, skipping strings', () => {
  const src = 'function f(a, b) {\n  return a > 0 && b > 0\n}\nconst label = "a > b"\n'
  const mutants = mutate(src)
  // three '>' (a>0, b>0) → wait: two '>' → ×2 mutators each = 4; one '&&' → 1  = 5; string '>' ignored
  const ops = mutants.map((m) => m.op).sort()
  expect(mutants.length).toBe(5)
  expect(ops.filter((o) => o.startsWith('>')).length).toBe(4)
  expect(ops.filter((o) => o === '&&→||').length).toBe(1)
  // none of the mutants touched the string-literal line (line 4)
  expect(mutants.every((m) => m.line !== 4)).toBe(true)
})

test('compound operators are not mis-mutated', () => {
  expect(mutate('const inc = () => i++').length).toBe(0) // => and ++ left intact
  expect(mutate('if (x >= 1) {}').map((m) => m.op)).toEqual(['>=→>'])
})

const R = (n: number, status: 'killed' | 'survived'): MutantResult => ({ id: n, line: 1, op: '+→-', status })

test('scoreGate passes at/above threshold', () => {
  const g = scoreGate([R(0, 'killed'), R(1, 'killed'), R(2, 'killed'), R(3, 'survived')], 0.75)
  expect(g.score).toBe(0.75)
  expect(g.pass).toBe(true)
})

test('scoreGate rejects below threshold and lists survivors', () => {
  const g = scoreGate([R(0, 'killed'), R(1, 'survived'), R(2, 'survived')], 0.75)
  expect(g.score).toBeCloseTo(0.33, 2)
  expect(g.pass).toBe(false)
  expect(g.survivors.length).toBe(2)
})

test('scoreGate treats zero-mutant module as ineligible', () => {
  const g = scoreGate([], 0.6)
  expect(g.score).toBeNull()
  expect(g.pass).toBe(false)
})
