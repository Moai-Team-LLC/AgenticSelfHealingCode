/**
 * @sho/rca-git — the REAL, git-backed GitBlameLogTool (loop-a §3). The Fake in @sho/loop-a returns
 * empty history, so in production G3 deploy-diff grounding is always null and every deploy-linked
 * incident ESCALATEs. This adapter runs read-only git over a real checkout so deploy-linked incidents
 * can actually reach CONFIRMED.
 *
 * SECURITY (loop-a §3, attack D7): git is invoked with execFileSync + an ARGV array — NEVER a shell
 * string — so a poisoned deploy record or log-borne injection can't reach a shell. The one field that
 * flows into an argument, `shaRange`, is additionally validated against a safe git-range charset before
 * use; anything else yields []. The interface is SYNCHRONOUS by contract (investigate() calls it inline),
 * so we stay sync and swallow every git error into [] — a bad range must never crash RCA.
 */

import { execFileSync } from 'node:child_process'
import type { GitBlameLogTool } from '@sho/loop-a'

/** Git rev-range charset: sha hex, refs, `..`/`...`, `~`/`^` ancestry, `.`, `/`, `-`, `_`. No shell metachars. */
const SAFE_RANGE = /^[0-9a-zA-Z._/~^-]+$/

/** Run read-only git; return trimmed stdout, or null on ANY error (missing repo, bad ref, non-zero exit). */
function gitOut(repo: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

/**
 * Extract a git sha-range from a deploy record. `diff_url` in this codebase already carries the range
 * form (`from..to`); a real GitHub compare URL puts the range in its last path segment
 * (`/compare/from...to`). Falls back to `deploy_id`. Thin by design — the charset guard in diff() is
 * what actually makes it safe.
 */
export function deployToShaRange(deploy: { deploy_id: string; diff_url?: string }): string {
  const raw = deploy.diff_url ?? deploy.deploy_id
  const compare = raw.match(/\/compare\/([^?#]+)/)
  return compare ? compare[1]! : raw
}

/** Parse `git blame --porcelain` unix time + tz (`+0300`) into an ISO-8601 instant. */
function porcelainTimeToIso(unixSeconds: string, tz: string): string {
  const secs = Number(unixSeconds)
  const m = /^([+-])(\d{2})(\d{2})$/.exec(tz)
  const offsetMs = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000 : 0
  // Render the timestamp AT the commit's own tz offset (not UTC) so author-local time is preserved.
  const local = new Date(secs * 1000 + offsetMs)
  const body = local.toISOString().slice(0, 19) // yyyy-mm-ddThh:mm:ss (of the shifted clock)
  return m ? `${body}${m[1]}${m[2]}:${m[3]}` : `${body}Z`
}

export class GitBlameLog implements GitBlameLogTool {
  private readonly repo: string
  constructor(opts: { repo: string }) {
    this.repo = opts.repo
  }

  /**
   * `git diff --unified=0 --no-color <shaRange>` → one entry per changed file: path from the `+++ b/`
   * header, hunk = the file's FIRST `@@` header. [] on a rejected/failed range.
   */
  diff(input: { shaRange: string }): { path: string; hunk: string }[] {
    if (!SAFE_RANGE.test(input.shaRange)) return []
    const out = gitOut(this.repo, ['diff', '--unified=0', '--no-color', input.shaRange])
    if (out === null) return []

    const entries: { path: string; hunk: string }[] = []
    let path: string | null = null
    let captured = false // first @@ of the current file already taken?
    for (const line of out.split('\n')) {
      if (line.startsWith('+++ ')) {
        // `+++ b/src/x.ts` or `+++ /dev/null` (deletion). Strip the `b/` prefix.
        const p = line.slice(4).replace(/^b\//, '')
        path = p === '/dev/null' ? null : p
        captured = false
      } else if (line.startsWith('@@') && path && !captured) {
        entries.push({ path, hunk: line })
        captured = true
      }
    }
    return entries
  }

  /**
   * `git blame --porcelain [-L a,b] -- <path>` → {sha, author, ts} per blamed line, in order. Porcelain
   * emits each commit's header block only on its FIRST line, so we cache author/time by sha and reuse it.
   */
  blame(input: { path: string; range?: [number, number] }): { sha: string; author: string; ts: string }[] {
    const args = ['blame', '--porcelain']
    if (input.range) args.push('-L', `${input.range[0]},${input.range[1]}`)
    args.push('--', input.path)
    const out = gitOut(this.repo, args)
    if (out === null) return []

    const meta = new Map<string, { author: string; time: string; tz: string }>()
    const rows: { sha: string; author: string; ts: string }[] = []
    const lines = out.split('\n')
    let cur: string | null = null // sha of the block currently being read

    for (const line of lines) {
      const header = /^([0-9a-f]{40})(?: \d+){2,3}$/.exec(line)
      if (header) {
        cur = header[1]!
        if (!meta.has(cur)) meta.set(cur, { author: '', time: '', tz: '' })
        continue
      }
      if (cur) {
        const m = meta.get(cur)!
        if (line.startsWith('author ')) m.author = line.slice(7)
        else if (line.startsWith('author-time ')) m.time = line.slice(12)
        else if (line.startsWith('author-tz ')) m.tz = line.slice(10)
        else if (line.startsWith('\t')) {
          // The content line closes one blamed source line — emit a row for the current sha.
          rows.push({ sha: cur, author: m.author, ts: porcelainTimeToIso(m.time, m.tz) })
          cur = null
        }
      }
    }
    return rows
  }

  /**
   * `git log --format=%H\t%cI\t%s [--follow] [--since=..] -- <path>` → {sha, ts, summary} newest-first.
   * %cI is already strict ISO-8601. Tab-separated; summaries never contain a tab.
   */
  log(input: { path: string; follow?: boolean; since?: string }): { sha: string; ts: string; summary: string }[] {
    const args = ['log', '--format=%H%x09%cI%x09%s']
    if (input.follow) args.push('--follow')
    if (input.since) args.push(`--since=${input.since}`)
    args.push('--', input.path)
    const out = gitOut(this.repo, args)
    if (out === null) return []

    const rows: { sha: string; ts: string; summary: string }[] = []
    for (const line of out.split('\n')) {
      if (!line) continue
      const tab1 = line.indexOf('\t')
      const tab2 = line.indexOf('\t', tab1 + 1)
      if (tab1 < 0 || tab2 < 0) continue
      rows.push({ sha: line.slice(0, tab1), ts: line.slice(tab1 + 1, tab2), summary: line.slice(tab2 + 1) })
    }
    return rows
  }
}
