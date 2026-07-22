import { test, expect } from 'bun:test'
import { classifyUpstream } from './src/index'

test('billing (402 / insufficient credits / quota) → actionable', () => {
  for (const t of ['HTTP 402 from provider', 'Insufficient credits', 'quota exceeded', 'credits exhausted — ran out', 'payment required']) {
    const d = classifyUpstream(t)!
    expect(d.cls).toBe('billing')
    expect(d.actionable).toBe(true)
    expect(d.action).toMatch(/top up|balance/i)
  }
})

test('auth (401/403 / invalid key) → actionable', () => {
  for (const t of ['401 unauthorized', 'invalid api key', '403 forbidden', 'permission denied']) {
    const d = classifyUpstream(t)!
    expect(d.cls).toBe('auth')
    expect(d.actionable).toBe(true)
  }
})

test('rate limit (429) → transient, NOT actionable', () => {
  const d = classifyUpstream('429 Too Many Requests — rate limit')!
  expect(d.cls).toBe('rate_limit')
  expect(d.actionable).toBe(false)
})

test('provider outage (5xx / timeout / ECONNRESET) → transient, NOT actionable', () => {
  for (const t of ['503 service unavailable', 'gateway timeout', 'ECONNRESET', 'upstream error 502 bad gateway']) {
    const d = classifyUpstream(t)!
    expect(d.cls).toBe('provider_outage')
    expect(d.actionable).toBe(false)
  }
})

test('the openrouter-balance case reads as billing, not a vague outage', () => {
  const d = classifyUpstream('openrouter/openai/gpt-4o-mini: 402 insufficient_credits')!
  expect(d.cls).toBe('billing')
  expect(d.cause).toMatch(/credit|quota/i)
})

test('an ordinary code error is NOT classified upstream (falls back to the RCA hypothesis)', () => {
  expect(classifyUpstream('TypeError: cannot read id of undefined in src/checkout/price.ts')).toBeNull()
  expect(classifyUpstream('race condition in the price cache')).toBeNull()
})
