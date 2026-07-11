import { test, expect } from 'bun:test'
import { createHmac } from 'node:crypto'
import { SlackNotifier, verifySlackSignature, parseSlackAction, type FetchLike } from './src/index'

test('SlackNotifier posts a message with Approve/Reject buttons carrying the callback values', () => {
  const calls: { url: string; body: any; auth?: string }[] = []
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization })
    return { ok: true, status: 200, async json() { return { ok: true } }, async text() { return '' } }
  }
  new SlackNotifier({ token: 'xoxb-x', fetchFn }).send({ channel: 'C1', text: 'a fix is ready', buttons: ['approve:appr-1', 'reject:appr-1'] })

  expect(calls[0]!.url).toBe('https://slack.com/api/chat.postMessage')
  expect(calls[0]!.auth).toBe('Bearer xoxb-x')
  const actions = calls[0]!.body.blocks.find((b: any) => b.type === 'actions')
  expect(actions.elements.map((e: any) => e.value)).toEqual(['approve:appr-1', 'reject:appr-1'])
  expect(actions.elements[0].text.text).toBe('✅ Approve')
  expect(actions.elements[0].style).toBe('primary')
  expect(actions.elements[1].style).toBe('danger')
})

test('verifySlackSignature accepts a correct v0 signature, rejects tampering / missing / stale', () => {
  const secret = 'shhh'
  const ts = '1700000000'
  const body = 'payload=%7B%7D'
  const sig = 'v0=' + createHmac('sha256', secret).update(`v0:${ts}:${body}`, 'utf8').digest('hex')
  expect(verifySlackSignature(body, ts, sig, secret)).toBe(true)
  expect(verifySlackSignature(body + 'x', ts, sig, secret)).toBe(false) // tampered body
  expect(verifySlackSignature(body, ts, null, secret)).toBe(false) // missing signature
  // stale timestamp (> 5 min from now) is rejected when nowMs is supplied
  expect(verifySlackSignature(body, ts, sig, secret, (Number(ts) + 3600) * 1000)).toBe(false)
})

test('parseSlackAction decodes the clicked button value + user from the form payload', () => {
  const payload = { actions: [{ action_id: 'approve:appr-1', value: 'approve:appr-1' }], user: { username: 'jane' } }
  const body = 'payload=' + encodeURIComponent(JSON.stringify(payload))
  expect(parseSlackAction(body)).toEqual({ value: 'approve:appr-1', user: 'jane' })
  expect(parseSlackAction('nothing=here')).toBeNull()
  expect(parseSlackAction('payload=not-json')).toBeNull()
})
