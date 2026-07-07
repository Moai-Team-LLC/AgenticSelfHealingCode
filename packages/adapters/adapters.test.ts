import { test, expect } from 'bun:test'
import type { IncidentCandidate } from '@sho/contracts'
import { TelegramNotifier, proposeWithClaude, requireEnv, optionalEnv, type FetchLike } from './src/index'

const candidate: IncidentCandidate = {
  id: 'i1', source: 'sentry', fingerprint: 'fp', severity: 2, first_seen: '2026-06-01T00:00:00Z',
  occurrences: 3, affected_service: 'checkout', affected_paths: ['src/checkout/price.ts'], recent_deploys: [], shape: 'unknown', raw_payload: {},
}

function recorder(response: unknown, ok = true, status = 200) {
  const calls: { url: string; body: any }[] = []
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return { ok, status, json: async () => response, text: async () => 'err' }
  }
  return { calls, fetchFn }
}

// ── Telegram: sync facade, async fire-and-forget, edit-in-place ──
test('TelegramNotifier sends then edits in place via the Bot API (offline, injected fetch)', async () => {
  const { calls, fetchFn } = recorder({ result: { message_id: 42 } })
  const tg = new TelegramNotifier({ token: 'TESTTOKEN', fetchFn })
  const ref = tg.send({ chat: '123', text: 'approval needed', buttons: ['approve', 'reject'] }, 1000)
  await tg.drain()
  expect(calls[0]!.url).toContain('/bot') // never assert the literal token
  expect(calls[0]!.url.endsWith('/sendMessage')).toBe(true)
  expect(calls[0]!.body.chat_id).toBe('123')
  expect(calls[0]!.body.text).toBe('approval needed')

  tg.send({ ref, chat: '123', text: 'reminder', buttons: ['approve', 'reject'] }, 2000)
  await tg.drain()
  expect(calls[1]!.url.endsWith('/editMessageText')).toBe(true)
  expect(calls[1]!.body.message_id).toBe(42) // edits the same message, never spams a new one
  expect(tg.get(ref)!.editedCount).toBe(1)
})

// ── Claude: model output is untrusted data, safe-parsed, never executed ──
test('proposeWithClaude parses a well-formed JSON proposal', async () => {
  const { fetchFn } = recorder({ content: [{ type: 'text', text: 'Here: {"primary":{"statement":"null deref in price","fixClass":"code","citedPath":"src/checkout/price.ts"},"alternatives":["upstream dep"]}' }] })
  const p = await proposeWithClaude({ candidate, evidenceSummary: 'deploy_linked' }, { apiKey: 'k', fetchFn })
  expect(p.primary.statement).toBe('null deref in price')
  expect(p.primary.fixClass).toBe('code')
  expect(p.primary.citedPath).toBe('src/checkout/price.ts')
  expect(p.alternatives).toEqual(['upstream dep'])
})

test('proposeWithClaude defaults to api.anthropic.com and honors a baseUrl override (model plane)', async () => {
  const body = { content: [{ type: 'text', text: '{}' }] }
  const direct = recorder(body)
  await proposeWithClaude({ candidate, evidenceSummary: 'x' }, { apiKey: 'k', fetchFn: direct.fetchFn })
  expect(direct.calls[0]!.url).toBe('https://api.anthropic.com/v1/messages')
  const routed = recorder(body)
  await proposeWithClaude(
    { candidate, evidenceSummary: 'x' },
    { apiKey: 'k', fetchFn: routed.fetchFn, baseUrl: 'http://localhost:8787/anthropic/' },
  )
  // trailing slash normalized; path appended once
  expect(routed.calls[0]!.url).toBe('http://localhost:8787/anthropic/v1/messages')
})

test('proposeWithClaude falls back safely on unparseable model output (no throw)', async () => {
  const { fetchFn } = recorder({ content: [{ type: 'text', text: 'I could not determine a cause.' }] })
  const p = await proposeWithClaude({ candidate, evidenceSummary: 'x' }, { apiKey: 'k', fetchFn })
  expect(p.primary.statement).toContain('Unclassified') // safe fallback, never a thrown error
  expect(p.primary.fixClass).toBe('code')
})

test('proposeWithClaude throws on a non-OK API response (fails loud, no silent degrade)', async () => {
  const { fetchFn } = recorder({}, false, 401)
  await expect(proposeWithClaude({ candidate, evidenceSummary: 'x' }, { apiKey: 'k', fetchFn })).rejects.toThrow('Anthropic API 401')
})

// ── env: fail-loud, never a literal in code ──
test('requireEnv / optionalEnv', () => {
  process.env.SHO_TEST_KEY = 'v'
  expect(requireEnv('SHO_TEST_KEY')).toBe('v')
  delete process.env.SHO_TEST_KEY
  expect(() => requireEnv('SHO_TEST_KEY')).toThrow('not set')
  expect(optionalEnv('SHO_TEST_KEY')).toBeUndefined()
})
