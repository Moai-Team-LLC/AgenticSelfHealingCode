/**
 * Driver for the mutation-score gate (gate.ts).
 *
 * For each generated mutant: write the mutated source over the file, run the test command, classify
 * killed (tests fail, non-zero exit) vs survived (tests pass, zero exit), then restore the original.
 * Runner-agnostic: only the exit code decides killed/survived, so it works with any test runner.
 *
 * Every run is TIME-BOXED (default 60s): the text-level operators are syntax-blind (e.g. `>` → `>=`
 * inside a TS generic yields `Record<string, unknown>=`, a parse error that can spin a runner
 * forever — observed live: bun's parser at 100% CPU indefinitely). A timed-out run counts as
 * KILLED: the mutant is non-viable, and standard mutation practice (Stryker et al.) scores
 * timeouts as killed. Without the box, one such mutant hangs the whole gate.
 */

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mutate, scoreGate, type MutantResult, type ScoreReport } from './gate'

/** Hard ceiling per mutant test run; SIGKILL so a hung parser cannot ignore it. */
const DEFAULT_MUTANT_TIMEOUT_MS = 60_000

function testsFail(testCmd: string, cwd: string, timeoutMs: number): boolean {
  try {
    execSync(testCmd, { cwd, stdio: 'ignore', timeout: timeoutMs, killSignal: 'SIGKILL' })
    return false // exit 0 → passed → mutant SURVIVED
  } catch {
    return true // non-zero exit, or timed out (non-viable mutant) → KILLED
  }
}

export function runMutationGate(opts: {
  dir: string
  sourceFile: string // relative to dir
  testCmd: string
  threshold: number
  /** Per-mutant wall-clock ceiling (ms). Default 60s; a timed-out mutant counts as killed. */
  mutantTimeoutMs?: number
}): ScoreReport {
  const path = join(opts.dir, opts.sourceFile)
  const original = readFileSync(path, 'utf8')
  const mutants = mutate(original)
  const timeoutMs = opts.mutantTimeoutMs ?? DEFAULT_MUTANT_TIMEOUT_MS
  const results: MutantResult[] = []
  try {
    for (const m of mutants) {
      writeFileSync(path, m.source)
      results.push({ id: m.id, line: m.line, op: m.op, status: testsFail(opts.testCmd, opts.dir, timeoutMs) ? 'killed' : 'survived' })
    }
  } finally {
    writeFileSync(path, original) // always restore
  }
  return scoreGate(results, opts.threshold)
}
