import { test, expect, afterEach } from 'bun:test'
import { buildServerDeps } from './src/server'

// buildServerDeps is env-driven glue: these tests pin which capabilities light up
// for which env combinations, on the in-memory fakes path (no DATABASE_URL).
const ENV_KEYS = [
  'DATABASE_URL', 'SIGNAL_SECRET', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL',
  'RCA_GIT_REPO', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID',
  'SENTRY_CLIENT_SECRET', 'TELEGRAM_WEBHOOK_SECRET', 'KILL_RELEASE_TOKEN',
] as const
const saved: Record<string, string | undefined> = {}
for (const k of ENV_KEYS) saved[k] = process.env[k]
function clearEnv() { for (const k of ENV_KEYS) delete process.env[k] }
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } })

test('bare env → in-memory fakes, no optional capability lights up', () => {
  clearEnv()
  const deps = buildServerDeps(() => 1000)
  expect(deps.propose).toBeUndefined()
  expect(deps.toolOverrides).toBeUndefined()
  expect(deps.answerCallback).toBeUndefined()
  expect(deps.deliverSinks).toEqual([])
  expect(deps.secret).toBeUndefined()
  expect(deps.sentryClientSecret).toBeUndefined()
  expect(deps.telegramWebhookSecret).toBeUndefined()
  expect(deps.mem).toBeDefined()
  expect(deps.notify).toBeDefined()
  expect(deps.killSwitch).toBeDefined()
  expect(deps.oplog).toBeDefined()
})

test('ANTHROPIC_API_KEY alone enables the proposer (base URL optional)', () => {
  clearEnv()
  process.env.ANTHROPIC_API_KEY = 'test-key'
  const deps = buildServerDeps(() => 1000)
  expect(typeof deps.propose).toBe('function')
})

test('Telegram delivery requires BOTH token and chat — token alone stays dark', () => {
  clearEnv()
  process.env.TELEGRAM_BOT_TOKEN = 't'
  let deps = buildServerDeps(() => 1000)
  expect(deps.deliverSinks).toEqual([])
  expect(deps.answerCallback).toBeUndefined()
  process.env.TELEGRAM_CHAT_ID = 'c'
  deps = buildServerDeps(() => 1000)
  expect(deps.deliverSinks?.length).toBe(1)
  expect(typeof deps.answerCallback).toBe('function')
})

test('chat alone (no token) also stays dark — the && is not an ||', () => {
  clearEnv()
  process.env.TELEGRAM_CHAT_ID = 'c'
  const deps = buildServerDeps(() => 1000)
  expect(deps.deliverSinks).toEqual([])
  expect(deps.answerCallback).toBeUndefined()
})

test('pass-through secrets land on deps verbatim', () => {
  clearEnv()
  process.env.SIGNAL_SECRET = 's1'
  process.env.SENTRY_CLIENT_SECRET = 's2'
  process.env.TELEGRAM_WEBHOOK_SECRET = 's3'
  const deps = buildServerDeps(() => 1000)
  expect(deps.secret).toBe('s1')
  expect(deps.sentryClientSecret).toBe('s2')
  expect(deps.telegramWebhookSecret).toBe('s3')
})
