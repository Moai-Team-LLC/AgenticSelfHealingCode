/**
 * Driver for the mutation-score gate (gate.ts).
 *
 * For each generated mutant: write the mutated source over the file, run the test command, classify
 * killed (tests fail, non-zero exit) vs survived (tests pass, zero exit), then restore the original.
 * Runner-agnostic: only the exit code decides killed/survived, so it works with any test runner.
 */

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mutate, scoreGate, type MutantResult, type ScoreReport } from './gate'

function testsFail(testCmd: string, cwd: string): boolean {
  try {
    execSync(testCmd, { cwd, stdio: 'ignore' })
    return false // exit 0 → passed → mutant SURVIVED
  } catch {
    return true // non-zero → failed → mutant KILLED
  }
}

export function runMutationGate(opts: {
  dir: string
  sourceFile: string // relative to dir
  testCmd: string
  threshold: number
}): ScoreReport {
  const path = join(opts.dir, opts.sourceFile)
  const original = readFileSync(path, 'utf8')
  const mutants = mutate(original)
  const results: MutantResult[] = []
  try {
    for (const m of mutants) {
      writeFileSync(path, m.source)
      results.push({ id: m.id, line: m.line, op: m.op, status: testsFail(opts.testCmd, opts.dir) ? 'killed' : 'survived' })
    }
  } finally {
    writeFileSync(path, original) // always restore
  }
  return scoreGate(results, opts.threshold)
}
