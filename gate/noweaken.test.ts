import { test, expect, beforeAll, afterAll } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { noWeakeningOverPaths } from './verify'

// A real git repo: an existing test with two strong assertions on the parent, weakened to one on the fix.
let repo: string, parentSha: string, fixSha: string
const g = (args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
const commit = (m: string) => { g(['add', '-A']); g(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', m]) }
const head = () => execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'noweaken-'))
  execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' })
  writeFileSync(join(repo, 'sum.js'), 'module.exports.sum = (a, b) => a + b;\n')
  writeFileSync(join(repo, 'sum.test.js'), 'expect(sum(2,3)).toBe(5);\nexpect(sum(0,0)).toBe(0);\n') // 2 strong
  commit('seed')
  parentSha = head()
  writeFileSync(join(repo, 'sum.test.js'), 'expect(sum(2,3)).not.toBeNull();\n') // dropped both strong asserts
  commit('weaken the existing test')
  fixSha = head()
})
afterAll(() => rmSync(repo, { recursive: true, force: true }))

test('an edited existing test that drops strong assertions is flagged — when it is in scope', () => {
  const v = noWeakeningOverPaths(repo, parentSha, fixSha, ['sum.test.js'])
  expect(v).not.toBeNull()
  expect(v!.pass).toBe(false)
  expect(v!.reason).toContain('loosened')
})

test('the same weakening is MISSED if the touched test file is out of scope (why we widen the set)', () => {
  // Only the declared new test would be checked; the edited existing test is invisible → the gap the fix closes.
  const missed = noWeakeningOverPaths(repo, parentSha, fixSha, [])
  expect(missed).toBeNull()
})
