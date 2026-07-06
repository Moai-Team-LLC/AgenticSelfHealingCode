import { test, expect, beforeAll, afterAll } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RepairContext } from '@sho/loop-c'
import { gitWorktreeSandbox, sandboxedRepairAuthor, type RepairProposal, type RepairProposer } from './src/index'

// ── A real git repo fixture with a genuine bug: add() subtracts instead of adds. The regression test
//    fails on this code and passes only once the fix is applied — so the grounded booleans are OBSERVED. ──
let repo: string
const g = (args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'sho-fixture-'))
  execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' })
  g(['config', 'user.email', 't@t'])
  g(['config', 'user.name', 't'])
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'src/calc.js'), 'module.exports.add = (a, b) => a - b;\n') // BUG: should be +
  g(['add', '-A'])
  g(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'seed'])
})
afterAll(() => rmSync(repo, { recursive: true, force: true }))

const ctx: RepairContext = {
  incidentId: 'inc-77', classKey: 'src::add', moduleArea: 'src', team: 't', primaryApprover: null, secondaryApprover: null,
  loopADecision: 'CONFIRMED', autonomy: { level: 'L1', tier: 2, requiredMutationScore: 0.6, accountableOwner: 'o' },
  whyTrace: {
    incidentId: 'inc-77', hypothesis: 'add() subtracts', alternatives: [], confidence: { reproduced: null, explainsAllOccurrences: null, affectedPathInDeployDiff: null, stepVsSlopeConsistent: null },
    correlationState: 'deploy_linked', affectedComponents: ['src/calc.js'], fixClass: 'code', recommendedAction: 'fix add', suspiciousContentFlag: false, similarIncidents: [],
  },
}

const TEST_SRC = "const { add } = require('./src/calc.js');\nif (add(2, 3) !== 5) { process.exit(1); }\n"
const fixingDiff = 'diff --git a/src/calc.js b/src/calc.js\n--- a/src/calc.js\n+++ b/src/calc.js\n@@ -1 +1 @@\n-module.exports.add = (a, b) => a - b;\n+module.exports.add = (a, b) => a + b;\n'
const nonFixingDiff = 'diff --git a/src/calc.js b/src/calc.js\n--- a/src/calc.js\n+++ b/src/calc.js\n@@ -1 +1 @@\n-module.exports.add = (a, b) => a - b;\n+module.exports.add = (a, b) => a - b; // touched, still broken\n'

const proposer = (over: Partial<RepairProposal>): RepairProposer => async () => ({
  summary: 'fix add', testPath: 'sho.regression.js', testSource: TEST_SRC, diff: fixingDiff, sourceFiles: ['src/calc.js'], touchedPaths: ['src/calc.js', 'sho.regression.js'], ...over,
})

function author(over: Partial<RepairProposal> = {}) {
  const sandbox = gitWorktreeSandbox({ repo, baseRef: 'HEAD', testCmd: ['node', 'sho.regression.js'], allowUntrustedExecution: true })
  return sandboxedRepairAuthor({ propose: proposer(over), sandbox })
}

test('grounded repro: reproduces on parent AND flips green on the real fix', async () => {
  const staged = (await author().author(ctx))!
  expect(staged).not.toBeNull()
  expect(staged.reproReproducedSignal).toBe(true) // the test FAILED on the buggy parent
  expect(staged.fixFlippedReproGreen).toBe(true) // the test PASSED after the fix
  expect(staged.parentSha).toMatch(/^[0-9a-f]{40}$/)
  expect(staged.fixSha).toMatch(/^[0-9a-f]{40}$/)
  expect(staged.fixSha).not.toBe(staged.parentSha)
  // the fix branch persists in the main repo (gate + PR reach it after the worktree is gone)
  const branchSha = execFileSync('git', ['-C', repo, 'rev-parse', 'sho/fix-inc-77'], { encoding: 'utf8' }).trim()
  expect(branchSha).toBe(staged.fixSha)
})

test('a diff that applies but does NOT fix → flippedGreen is false (booleans are real, not always-true)', async () => {
  const staged = (await author({ diff: nonFixingDiff }).author(ctx))!
  expect(staged.reproReproducedSignal).toBe(true)
  expect(staged.fixFlippedReproGreen).toBe(false) // the bug remains → downstream runRepair blocks it
})

test('mutation set is derived from the diff, not the declaration (undeclared touched file gets covered)', async () => {
  // The author declares NO source files, but the diff writes src/calc.js — it must end up in sourceFiles so
  // the mutation gate covers it (else a fix in an undeclared file gets zero mutation coverage).
  const staged = (await author({ sourceFiles: [] }).author(ctx))!
  expect(staged.sourceFiles).toContain('src/calc.js')
})

test('a malformed diff (does not apply) → author declines (null), never crashes', async () => {
  const staged = await author({ diff: 'this is not a diff' }).author(ctx)
  expect(staged).toBeNull()
})

test('a proposal touching a protected path → declined before any execution', async () => {
  const staged = await author({ touchedPaths: ['src/calc.js', 'src/auth/session.ts'], sourceFiles: ['src/auth/session.ts'] }).author(ctx)
  expect(staged).toBeNull()
})

test('an UNDER-DECLARED protected write (diff touches src/auth, declares only src/calc.js) → declined', async () => {
  // The author declares benign paths, but the DIFF itself writes a protected file. The diff-derived path
  // check (not the self-report) must catch it before any execution.
  const sneakyDiff = 'diff --git a/src/auth/session.ts b/src/auth/session.ts\n--- a/src/auth/session.ts\n+++ b/src/auth/session.ts\n@@ -1 +1 @@\n-x\n+y\n'
  const staged = await author({ diff: sneakyDiff, touchedPaths: ['src/calc.js'], sourceFiles: ['src/calc.js'] }).author(ctx)
  expect(staged).toBeNull()
})

test('the sandbox refuses to run without explicit untrusted-execution acknowledgment', () => {
  expect(() => gitWorktreeSandbox({ repo, baseRef: 'HEAD', testCmd: ['node', 'x'] } as unknown as Parameters<typeof gitWorktreeSandbox>[0])).toThrow(/allowUntrustedExecution/)
})
