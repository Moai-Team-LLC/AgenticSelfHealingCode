import { test, expect } from 'bun:test'
import { createHmac } from 'node:crypto'
import { githubPublisher, verifyGithubSignature, parseMergedPr, type FetchLike } from './src/index'

test('githubPublisher POSTs a PR and returns url/number/headSha', async () => {
  const calls: { url: string; body: unknown; auth?: string }[] = []
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization })
    return { ok: true, status: 201, async json() { return { number: 42, html_url: 'https://github.com/o/r/pull/42', head: { sha: 'deadbeef' } } }, async text() { return '' } }
  }
  const pub = githubPublisher({ token: 'ght_x', owner: 'o', repo: 'r', fetchFn })
  const out = await pub.publish({ incidentId: 'inc-9', classKey: 'src/checkout::E', title: 'fix', body: 'why', headSha: 'aaa', baseSha: 'bbb' })

  expect(out).toEqual({ url: 'https://github.com/o/r/pull/42', number: 42, headSha: 'deadbeef' })
  expect(calls[0]!.url).toBe('https://api.github.com/repos/o/r/pulls')
  expect(calls[0]!.auth).toBe('Bearer ght_x')
  expect(calls[0]!.body).toMatchObject({ title: 'fix', head: 'sho/fix-inc-9', base: 'main' })
})

test('githubPublisher throws on a non-2xx or malformed response (never silently degrades)', async () => {
  const bad: FetchLike = async () => ({ ok: false, status: 422, async json() { return {} }, async text() { return 'branch missing' } })
  await expect(githubPublisher({ token: 't', owner: 'o', repo: 'r', fetchFn: bad }).publish({ incidentId: 'i', classKey: 'c', title: 't', body: 'b', headSha: 'h', baseSha: 'p' })).rejects.toThrow(/422/)

  const malformed: FetchLike = async () => ({ ok: true, status: 201, async json() { return { note: 'no number' } }, async text() { return '' } })
  await expect(githubPublisher({ token: 't', owner: 'o', repo: 'r', fetchFn: malformed }).publish({ incidentId: 'i', classKey: 'c', title: 't', body: 'b', headSha: 'h', baseSha: 'p' })).rejects.toThrow(/malformed/)
})

test('verifyGithubSignature accepts a correct sha256 HMAC, rejects tampering + missing header', () => {
  const secret = 'whsec'
  const body = '{"action":"closed"}'
  const sig = 'sha256=' + createHmac('sha256', secret).update(body, 'utf8').digest('hex')
  expect(verifyGithubSignature(body, sig, secret)).toBe(true)
  expect(verifyGithubSignature(body + ' ', sig, secret)).toBe(false) // tampered body
  expect(verifyGithubSignature(body, null, secret)).toBe(false) // missing header
})

test('parseMergedPr returns a MergedPr only for an actually-merged PR', () => {
  const merged = parseMergedPr({ action: 'closed', pull_request: { number: 7, merged: true, merge_commit_sha: 'mc7', head: { sha: 'h7' }, merged_by: { login: 'alice' } } })
  expect(merged).toEqual({ number: 7, headSha: 'h7', mergeCommitSha: 'mc7', mergedBy: 'alice' })

  expect(parseMergedPr({ action: 'closed', pull_request: { number: 7, merged: false } })).toBeNull() // closed, not merged
  expect(parseMergedPr({ action: 'opened', pull_request: { number: 7, merged: true } })).toBeNull() // not a close
  expect(parseMergedPr({ zen: 'ping' })).toBeNull() // webhook ping
})
