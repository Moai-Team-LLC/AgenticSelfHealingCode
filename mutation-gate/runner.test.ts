import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runMutationGate } from './runner'

// Regression: text-level operators are syntax-blind — `>` → `>=` inside a TS
// generic (`Record<string, unknown>`) yields a parse error that spun bun's
// parser at 100% CPU FOREVER, hanging the whole gate. The per-mutant timeout
// must bound every run and count the timed-out (non-viable) mutant as killed.
test('a mutant that hangs the test runner is time-boxed and counted killed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vgate-timeout-'))
  try {
    // One mutable operator (`+`), so exactly one deterministic mutant set.
    writeFileSync(join(dir, 'mod.ts'), 'export const add = (a: number, b: number) => a + b\n')
    const started = Date.now()
    // The "suite" ignores the mutant entirely and just hangs well past the box.
    const report = runMutationGate({
      dir,
      sourceFile: 'mod.ts',
      testCmd: 'sleep 30',
      threshold: 0.5,
      mutantTimeoutMs: 500,
    })
    const elapsed = Date.now() - started
    expect(elapsed).toBeLessThan(10_000) // bounded, not 30s×mutants
    expect(report.total).toBeGreaterThan(0)
    expect(report.killed).toBe(report.total) // timeout → killed (non-viable)
    expect(report.pass).toBe(true)
    // the original source is always restored
    expect(readFileSync(join(dir, 'mod.ts'), 'utf8')).toContain('a + b')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a fast-passing suite still marks mutants survived under the timeout box', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vgate-fast-'))
  try {
    writeFileSync(join(dir, 'mod.ts'), 'export const add = (a: number, b: number) => a + b\n')
    const report = runMutationGate({
      dir,
      sourceFile: 'mod.ts',
      testCmd: 'true', // exit 0 regardless → every mutant survives
      threshold: 0.5,
      mutantTimeoutMs: 5_000,
    })
    expect(report.total).toBeGreaterThan(0)
    expect(report.killed).toBe(0)
    expect(report.pass).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
