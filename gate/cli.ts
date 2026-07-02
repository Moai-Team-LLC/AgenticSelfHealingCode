#!/usr/bin/env bun
/**
 * Verification Gate — CI entrypoint. Runs verify() on a PR's (base, head) and sets the exit code.
 *
 *   bun run gate/cli.ts --repo . --base <baseSHA> --head <headSHA> --min-mutation-score 0.75
 *
 * Detects changed files from the diff, classifies test vs source, and:
 *   - source changed but NO test in the diff → REJECT (Principle 2: a fix must add a regression test).
 *   - test-only change → run the changed tests at head; pass if green (full gate N/A, low blast radius).
 *   - source + test → full verify() (must-fail-on-parent + mutation score + no-weakening).
 * Writes a GitHub step summary + ::error:: annotations when run in Actions. Exit 0 = pass, 1 = reject.
 */

import { execFileSync, execSync } from 'node:child_process'
import { resolve } from 'node:path'
import { appendFileSync } from 'node:fs'
import { verify, type GateResult } from './verify'

const TEST_RE = /(?:^|\/)(?:__tests__\/|[^/]*\.(?:test|spec)\.[cm]?[jt]sx?$)/
const SRC_RE = /\.[cm]?[jt]sx?$/
const IGNORE_RE = /(?:\.d\.ts$|\.config\.[cm]?[jt]s$|(?:^|\/)node_modules\/)/

export function classifyChanged(paths: string[]): { tests: string[]; sources: string[] } {
  const tests: string[] = []
  const sources: string[] = []
  for (const p of paths) {
    if (IGNORE_RE.test(p)) continue
    if (TEST_RE.test(p)) tests.push(p)
    else if (SRC_RE.test(p)) sources.push(p)
  }
  return { tests, sources }
}

/** Parse `git diff --name-status`: drop deletes, follow renames to the new path. */
export function parseNameStatus(out: string): string[] {
  const files: string[] = []
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts[0].startsWith('D')) continue
    files.push(parts[0].startsWith('R') ? parts[2] : parts[1])
  }
  return files
}

function detectChanged(repo: string, base: string, head: string): string[] {
  return parseNameStatus(execFileSync('git', ['-C', repo, 'diff', '--name-status', base, head], { encoding: 'utf8' }))
}

// ---- rendering ------------------------------------------------------------

function human(r: GateResult): string {
  const s = r.signals
  return [
    `Verification Gate: ${r.pass ? 'PASS ✅' : 'REJECT ❌'} — ${r.reason}`,
    `  must-fail-on-parent: ${s.mustFailOnParent.pass ? 'pass' : 'REJECT'} (${s.mustFailOnParent.code})`,
    `  mutation score:      ${s.mutationScore.score?.toFixed(2) ?? 'n/a'} / ${s.mutationScore.threshold} (${s.mutationScore.killed}/${s.mutationScore.total}) → ${s.mutationScore.pass ? 'pass' : 'REJECT'}`,
    `  no-weakening:        ${s.noWeakening ? (s.noWeakening.pass ? 'pass' : 'REJECT') : 'n/a (new test)'}`,
    `  diffLines: ${s.diffLines}  exceedsClassBudget: ${s.exceedsClassBudget}  moduleArea: ${r.context.moduleArea}`,
  ].join('\n')
}

function ghSummary(md: string) {
  const f = process.env.GITHUB_STEP_SUMMARY
  if (f) try { appendFileSync(f, md + '\n') } catch { /* not in CI */ }
}

function fail(msg: string): never {
  console.log(`Verification Gate: REJECT ❌ — ${msg}`)
  console.log(`::error::Verification Gate: ${msg}`)
  ghSummary(`### Verification Gate ❌\n${msg}\n`)
  process.exit(1)
}

// ---- main -----------------------------------------------------------------

export function parseArgs(argv: string[]) {
  const o: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const eq = a.indexOf('=')
    if (eq >= 0) { o[a.slice(2, eq)] = a.slice(eq + 1); continue } // --key=value
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) { o[key] = next; i++ } // --key value
    else o[key] = 'true' // bare flag
  }
  return o
}

function main() {
  const a = parseArgs(process.argv.slice(2))
  if (!a.base) { console.error('usage: bun run cli.ts --base <sha> [--head <sha>] [--repo .] [--min-mutation-score 0.75] [--test-cmd "…"]'); process.exit(2) }
  const repo = resolve(a.repo ?? '.')
  const head = a.head ?? 'HEAD'
  const list = (v?: string) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined)

  let tests = list(a.tests)
  let sources = list(a.sources)
  if (!tests || !sources) {
    const c = classifyChanged(detectChanged(repo, a.base, head))
    tests ??= c.tests
    sources ??= c.sources
  }

  if (tests.length === 0 && sources.length === 0) { console.log('Verification Gate: no gate-relevant changes — SKIP ✅'); process.exit(0) }
  if (tests.length === 0) fail('a code change must include a regression test (Principle 2). No *.test.* / *.spec.* file in the diff.')

  const testCmd = a['test-cmd'] ?? `bun test ${tests.join(' ')}`

  if (sources.length === 0) {
    try { execSync(testCmd, { cwd: repo, stdio: 'ignore' }); console.log('Verification Gate: test-only change — tests green, full gate N/A — PASS ✅'); process.exit(0) }
    catch { fail('test-only change but the changed tests do not pass at head.') }
  }

  const result = verify({
    repo, parentRef: a.base, fixRef: head,
    testPaths: tests, sourceFiles: sources, testCmd,
    requiredMutationScore: Number(a['min-mutation-score'] ?? 0.75),
    classDiffBudget: Number(a['class-diff-budget'] ?? 15),
  })
  console.log(a.json ? JSON.stringify(result, null, 2) : human(result))
  const badge = result.pass ? '✅' : '❌'
  ghSummary(`### Verification Gate ${badge}\n\n\`\`\`\n${human(result)}\n\`\`\``)
  if (!result.pass) console.log(`::error::Verification Gate REJECT — ${result.reason}`)
  process.exit(result.pass ? 0 : 1)
}

if (import.meta.main) main()
