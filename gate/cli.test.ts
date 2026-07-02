import { test, expect } from 'bun:test'
import { classifyChanged, parseNameStatus, parseArgs } from './cli'

test('parseArgs handles --key value, --key=value, and bare flags', () => {
  const o = parseArgs(['--repo', '/x', '--base', 'abc', '--min-mutation-score=0.8', '--json'])
  expect(o.repo).toBe('/x') // space-separated (what the workflow uses)
  expect(o.base).toBe('abc')
  expect(o['min-mutation-score']).toBe('0.8') // = form
  expect(o.json).toBe('true') // bare flag
})

test('classifyChanged separates tests, sources, and ignores', () => {
  const { tests, sources } = classifyChanged([
    'src/checkout/price.ts',
    'src/checkout/price.test.ts',
    'src/api/__tests__/handler.ts',
    'src/api/handler.tsx',
    'types/global.d.ts',
    'vitest.config.ts',
    'node_modules/pkg/index.js',
    'README.md',
  ])
  expect(sources.sort()).toEqual(['src/api/handler.tsx', 'src/checkout/price.ts'])
  expect(tests.sort()).toEqual(['src/api/__tests__/handler.ts', 'src/checkout/price.test.ts'])
  // .d.ts, config, node_modules, and non-code are excluded from both
})

test('classifyChanged handles .spec and mjs/cjs', () => {
  const { tests, sources } = classifyChanged(['a.spec.jsx', 'b.mjs', 'c.cjs'])
  expect(tests).toEqual(['a.spec.jsx'])
  expect(sources.sort()).toEqual(['b.mjs', 'c.cjs'])
})

test('parseNameStatus drops deletes and follows renames', () => {
  const out = 'M\tsrc/a.ts\nA\tsrc/b.test.ts\nD\tsrc/old.ts\nR100\tsrc/c.ts\tsrc/c2.ts\n'
  expect(parseNameStatus(out)).toEqual(['src/a.ts', 'src/b.test.ts', 'src/c2.ts'])
})
