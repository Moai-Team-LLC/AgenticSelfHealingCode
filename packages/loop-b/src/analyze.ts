/**
 * Loop B — driver: turn a red test into a decision by running it and extracting the discriminator's
 * signals. Composes ./signals + ./flaky + ./discriminator. Runner-agnostic on exit code; parses bun
 * test output for counts. A heal approved downstream is validated by ../verification-gate.
 *
 * The two side effects — running a test and reading the test source — live behind the injected
 * `AnalyzeDeps` interface so the driver is testable NOW with an in-memory fake (no child process, no
 * filesystem). The default deps are the thin real adapters over node:child_process / node:fs.
 */

import { classify, type BrokenSignals } from './discriminator'
import { detectFlaky } from './flaky'
import { classifyFailureMode, coversOutsideDiff } from './signals'
import type { LoopBDecision } from '@sho/contracts'

export interface RunOutcome { ran: boolean; passed: boolean; output: string }

/** Injected infrastructure: run a single test file, and read a test file's source. */
export interface AnalyzeDeps {
  runTestOnce: (dir: string, testFile: string) => RunOutcome
  readTestSource: (dir: string, testFile: string) => string
}

/** Parse bun-test-style output ("N pass / M fail") into a RunOutcome. Pure — exported for reuse/tests. */
export function parseRunOutput(output: string): RunOutcome {
  const passes = Number(output.match(/(\d+)\s+pass/)?.[1] ?? 0)
  const fails = Number(output.match(/(\d+)\s+fail/)?.[1] ?? 0)
  const ran = passes + fails > 0
  return { ran, passed: ran && fails === 0, output }
}

/** The real adapters: thin code over node:child_process (bun test) and node:fs. Lazily required so a
 *  consumer that injects a fake never pulls node built-ins. */
export function defaultDeps(): AnalyzeDeps {
  return {
    runTestOnce(dir, testFile) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { execSync } = require('node:child_process') as typeof import('node:child_process')
      let output = ''
      try {
        output = execSync(`bun test ${testFile} 2>&1`, { cwd: dir, encoding: 'utf8' })
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string }
        output = `${err.stdout ?? ''}${err.stderr ?? ''}`
      }
      return parseRunOutput(output)
    },
    readTestSource(dir, testFile) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { readFileSync } = require('node:fs') as typeof import('node:fs')
      const { join } = require('node:path') as typeof import('node:path')
      return readFileSync(join(dir, testFile), 'utf8')
    },
  }
}

export interface Analysis {
  broken: boolean
  decision?: LoopBDecision
  signals?: BrokenSignals
  outputSnippet?: string
}

/**
 * Analyze a (possibly) red test on the current tree. `changedSources` = the source files the change
 * touched (repo-relative), used for the out-of-diff signal. `reruns` = flaky re-run count. `deps`
 * injects the two side effects (defaults to the real child-process/fs adapters).
 */
export function analyzeBrokenTest(
  dir: string,
  testFile: string,
  changedSources: string[],
  reruns = 8,
  deps: AnalyzeDeps = defaultDeps(),
): Analysis {
  const first = deps.runTestOnce(dir, testFile)
  if (first.passed) return { broken: false }

  const flaky = detectFlaky(() => deps.runTestOnce(dir, testFile).passed, reruns).flaky
  const signals: BrokenSignals = {
    ran: first.ran,
    flaky,
    failureMode: classifyFailureMode(first.output),
    coversOutsideDiff: coversOutsideDiff(deps.readTestSource(dir, testFile), changedSources),
  }
  return {
    broken: true,
    decision: classify(signals),
    signals,
    outputSnippet: first.output.split('\n').filter((l) => /fail|error|expect|Ran/i.test(l)).slice(0, 3).join(' · '),
  }
}
