/**
 * Loop B — driver: turn a red test into a Decision by running it and extracting the discriminator's
 * signals. Composes ./signals + ./flaky + ./discriminator. Runner-agnostic on exit code; parses bun
 * test output for counts. A heal approved downstream is validated by ../verification-gate.
 */

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { classify, type BrokenSignals, type Decision } from './discriminator'
import { detectFlaky } from './flaky'
import { classifyFailureMode, coversOutsideDiff } from './signals'

interface RunOutcome { ran: boolean; passed: boolean; output: string }

function runTestOnce(dir: string, testFile: string): RunOutcome {
  let output = ''
  try {
    output = execSync(`bun test ${testFile} 2>&1`, { cwd: dir, encoding: 'utf8' })
  } catch (e: any) {
    output = `${e.stdout ?? ''}${e.stderr ?? ''}`
  }
  const passes = Number(output.match(/(\d+)\s+pass/)?.[1] ?? 0)
  const fails = Number(output.match(/(\d+)\s+fail/)?.[1] ?? 0)
  const ran = passes + fails > 0
  return { ran, passed: ran && fails === 0, output }
}

export interface Analysis {
  broken: boolean
  decision?: Decision
  signals?: BrokenSignals
  outputSnippet?: string
}

/**
 * Analyze a (possibly) red test on the current tree. `changedSources` = the source files the change
 * touched (repo-relative), used for the out-of-diff signal. `reruns` = flaky re-run count.
 */
export function analyzeBrokenTest(dir: string, testFile: string, changedSources: string[], reruns = 8): Analysis {
  const first = runTestOnce(dir, testFile)
  if (first.passed) return { broken: false }

  const flaky = detectFlaky(() => runTestOnce(dir, testFile).passed, reruns).flaky
  const signals: BrokenSignals = {
    ran: first.ran,
    flaky,
    failureMode: classifyFailureMode(first.output),
    coversOutsideDiff: coversOutsideDiff(readFileSync(join(dir, testFile), 'utf8'), changedSources),
  }
  return {
    broken: true,
    decision: classify(signals),
    signals,
    outputSnippet: first.output.split('\n').filter((l) => /fail|error|expect|Ran/i.test(l)).slice(0, 3).join(' · '),
  }
}
