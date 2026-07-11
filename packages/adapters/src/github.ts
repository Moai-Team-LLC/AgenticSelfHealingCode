/**
 * GitHub adapter for Loop C's PR channel (LOOP-C-DEFERRED §5.1: every fix is an L1 PR for the HITL ladder).
 * Two halves, both offline-testable via an injected fetch and NEVER holding a key literal:
 *   - `githubPublisher` — opens the PR that carries the gated diff for a human to merge (the ChangeRequest port).
 *   - `verifyGithubSignature` + `parseMergedPr` — verify and decode the merge webhook that confirms it.
 *
 * The token (a fine-grained PAT / GitHub App token scoped to pull-requests:write) is passed in by the caller
 * from the gitignored connectors/.env — this module never contains one and never logs one.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { ChangeRequestInput, ChangeRequestPublisher, PublishedChangeRequest } from '@sho/loop-c'
import type { FetchLike } from './env'
import { realFetch } from './env'

export interface GithubOptions {
  token: string
  owner: string
  repo: string
  /** the branch a Loop C PR targets (the PR's base). Default 'main'. */
  baseBranch?: string
  /** the sandbox pushes the fix to `${prefix}${incidentId}`; the PR's head. Default 'sho/fix-'. */
  headBranchPrefix?: string
  fetchFn?: FetchLike
  apiBase?: string
}

/** A ChangeRequestPublisher backed by the GitHub REST API (POST /repos/{owner}/{repo}/pulls). */
export function githubPublisher(opts: GithubOptions): ChangeRequestPublisher {
  const base = opts.apiBase ?? 'https://api.github.com'
  const f = opts.fetchFn ?? realFetch
  return {
    async publish(input: ChangeRequestInput): Promise<PublishedChangeRequest> {
      const head = `${opts.headBranchPrefix ?? 'sho/fix-'}${input.incidentId}`
      const res = await f(`${base}/repos/${opts.owner}/${opts.repo}/pulls`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${opts.token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ title: input.title, body: input.body, head, base: opts.baseBranch ?? 'main' }),
      })
      if (!res.ok) throw new Error(`GitHub PR create ${res.status}: ${await res.text()}`)
      const j = (await res.json()) as { number?: number; html_url?: string; head?: { sha?: string } }
      if (typeof j.number !== 'number' || typeof j.html_url !== 'string') {
        throw new Error('GitHub PR create: malformed response (missing number/html_url)')
      }
      return { url: j.html_url, number: j.number, headSha: j.head?.sha ?? input.headSha }
    },
  }
}

/** Verify a GitHub webhook `x-hub-signature-256` (HMAC-SHA256 of the raw body). Constant-time compare. */
export function verifyGithubSignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
  const a = Buffer.from(header)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** The subset of a `pull_request` webhook we act on: a merged (not merely closed) PR. */
export interface MergedPr {
  number: number
  headSha: string
  mergeCommitSha: string | null
  mergedBy: string
}

/** Decode a `pull_request` webhook payload → MergedPr iff it is a merge event, else null (ignored). */
export function parseMergedPr(payload: unknown): MergedPr | null {
  const o = payload as Record<string, unknown> | null
  if (!o || o.action !== 'closed') return null
  const pr = o.pull_request as Record<string, unknown> | undefined
  if (!pr || pr.merged !== true || typeof pr.number !== 'number') return null
  const head = pr.head as { sha?: string } | undefined
  const mergedByUser = pr.merged_by as { login?: string } | undefined
  return {
    number: pr.number,
    headSha: head?.sha ?? '',
    mergeCommitSha: typeof pr.merge_commit_sha === 'string' ? pr.merge_commit_sha : null,
    mergedBy: mergedByUser?.login ?? 'github:unknown',
  }
}
