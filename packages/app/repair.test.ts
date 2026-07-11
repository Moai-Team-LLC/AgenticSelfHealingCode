import { test, expect } from 'bun:test'
import { createHmac } from 'node:crypto'
import { InMemoryIncidentMemory } from '@sho/incident-memory'
import { NotifyStore, InMemoryAutoActionStore, KillSwitch } from '@sho/orchestrator'
import { ApprovalQueue } from '@sho/hitl'
import { criticalityFromMap } from '@sho/aggregation'
import { InMemoryTelemetry } from '@sho/contracts'
import { FakeGitBlameLog, type SandboxReproTool, type TraceCorrelateTool, type LlmClient } from '@sho/loop-a'
import { FakeRepairAuthor, RecordingPublisher, passGate, fakeStaged } from '@sho/loop-c'
import { createFetchHandler, IncidentLog, RepairIndex, type AppDeps, type RepairDeps } from './src/index'

const SECRET = 'repair-secret'
const GH = 'gh-webhook-secret'
const sign = (b: string) => createHmac('sha256', SECRET).update(b, 'utf8').digest('hex')
const ghSign = (b: string) => 'sha256=' + createHmac('sha256', GH).update(b, 'utf8').digest('hex')

const KNOWN = 'TypeError_checkout_price'
const demoRepro: SandboxReproTool = { reproduce: ({ replay }) => ({ reproduced: replay.ref === KNOWN }) }
const demoTrace: TraceCorrelateTool = {
  correlate: ({ fingerprint, sample }) =>
    fingerprint === KNOWN ? { sampled: sample, matched: sample, localizedToOneSpan: sample } : { sampled: sample, matched: 0, localizedToOneSpan: 0 },
}
const demoLlm: LlmClient = {
  propose: ({ candidate }) =>
    candidate.fingerprint === KNOWN
      ? { primary: { statement: 'Null deref in price total after d1', fixClass: 'code', citedPath: 'src/checkout/price.ts' }, alternatives: ['upstream'] }
      : { primary: { statement: 'unconfirmed', fixClass: 'code', citedPath: candidate.affected_paths[0] }, alternatives: [] },
}

/** A signal that reaches CONFIRMED + fixClass=code (the demo's deploy-linked checkout exception). */
function knownSignal(id = 'inc-repair-1') {
  return JSON.stringify({
    id, fingerprint: KNOWN, service: 'checkout', severity: 3, occurrences: 12,
    affected_paths: ['src/checkout/price.ts'], first_seen: new Date().toISOString(), shape: 'step',
    title: 'TypeError in checkout', message: "cannot read 'id' of undefined", error_class: 'TypeError',
    recent_deploys: [{ deploy_id: 'd1', ts: new Date(Date.now() - 30 * 60_000).toISOString(), diff_url: 'abc..def' }],
  })
}

function makeDeps(over: Partial<RepairDeps> = {}) {
  const approvals = new ApprovalQueue()
  const store = new InMemoryAutoActionStore()
  const index = new RepairIndex()
  const publisher = new RecordingPublisher()
  const telemetry = new InMemoryTelemetry()
  const killSwitch = new KillSwitch(Date.now(), 30_000, 'release-tok')
  const repair: RepairDeps = {
    author: new FakeRepairAuthor(fakeStaged()),
    runGate: passGate(),
    publisher,
    approvals,
    store,
    index,
    resolveAutonomy: (_c, _a, killed) => ({ level: killed ? 'L0' : 'L1', tier: killed ? 1 : 2, requiredMutationScore: 0.6, accountableOwner: 'team-checkout' }),
    routing: () => ({ team: 'checkout', primaryApprover: 'p', secondaryApprover: 's' }),
    githubWebhookSecret: GH,
    ...over,
  }
  const deps: AppDeps = {
    mem: new InMemoryIncidentMemory(), notify: new NotifyStore(), criticality: criticalityFromMap({ checkout: 5 }),
    secret: SECRET, telemetry, oplog: new IncidentLog(), telegramWebhookSecret: 'tg-secret', slackSigningSecret: 'slack-secret', killSwitch,
    toolOverrides: { repro: demoRepro, trace: demoTrace, git: new FakeGitBlameLog([{ path: 'src/checkout/price.ts', hunk: '@@ -12,7 +12,7 @@' }]), llm: demoLlm },
    repair,
  }
  return { deps, handler: createFetchHandler(deps), approvals, store, index, publisher, telemetry, killSwitch }
}

async function propose(handler: (r: Request) => Promise<Response>, id = 'inc-repair-1') {
  const b = knownSignal(id)
  const res = await handler(new Request('http://x/webhook/sentry', { method: 'POST', headers: { 'x-signature': sign(b) }, body: b }))
  return (await res.json()) as { gate: string }
}

test('CONFIRMED code diagnosis → a proposal (PR + L1 approval), but NO landing yet', async () => {
  const { handler, approvals, store, index, publisher } = makeDeps()
  const r = await propose(handler)
  expect(r.gate).toBe('CONFIRMED')

  // one proposal tracked, one PR opened, one OPEN loop-C tier-2 approval
  expect(index.list()).toHaveLength(1)
  expect(publisher.published).toHaveLength(1)
  const appr = approvals.all()[0]!
  expect(appr.loop).toBe('C')
  expect(appr.tier).toBe(2)
  expect(appr.state).toBe('OPEN')

  // CRUCIAL: proposing writes NO landing — a human has not confirmed.
  expect(store.listByClass(index.list()[0]!.classKey)).toHaveLength(0)
})

test('channel 1 — GitHub PR merge webhook confirms → human_approved loop-C landing', async () => {
  const { handler, store, index } = makeDeps()
  await propose(handler)
  const rec = index.list()[0]!

  // The gated tip is what merged (head.sha === rec.fixSha) → land, and land the GATED sha, not the merge commit.
  const payload = JSON.stringify({ action: 'closed', pull_request: { number: rec.prNumber, merged: true, merge_commit_sha: 'mergesha9', head: { sha: rec.fixSha }, merged_by: { login: 'alice' } } })
  const res = await handler(new Request('http://x/webhook/github', { method: 'POST', headers: { 'x-hub-signature-256': ghSign(payload) }, body: payload }))
  const body = (await res.json()) as { ok: boolean; landed: boolean; actionId: string }
  expect(res.status).toBe(200)
  expect(body.landed).toBe(true)

  const landings = store.listByClass(rec.classKey)
  expect(landings).toHaveLength(1)
  expect(landings[0]!.applied_by).toBe('human_approved')
  expect(landings[0]!.loop).toBe('C')
  expect(landings[0]!.fix_sha).toBe(rec.fixSha) // the GATED commit, never the ungated merge commit
  expect(landings[0]!.accountable_owner).toBe('team-checkout') // = trust_class.owner, not the merger
  expect(index.byApprovalId(rec.approvalId)!.status).toBe('confirmed')
})

test('stale gate: merged head differs from the gated sha → NO landing, needs_regate', async () => {
  const { handler, store, index } = makeDeps()
  await propose(handler)
  const rec = index.list()[0]!
  // a human pushed a new commit after the gate passed → head.sha != the gated fixSha
  const payload = JSON.stringify({ action: 'closed', pull_request: { number: rec.prNumber, merged: true, merge_commit_sha: 'm9', head: { sha: 'edited-after-gate' }, merged_by: { login: 'alice' } } })
  const res = await handler(new Request('http://x/webhook/github', { method: 'POST', headers: { 'x-hub-signature-256': ghSign(payload) }, body: payload }))
  const body = (await res.json()) as { landed: boolean; regate: boolean }
  expect(body.landed).toBe(false)
  expect(body.regate).toBe(true)
  expect(store.listByClass(rec.classKey)).toHaveLength(0) // never stamped a stale PASS onto ungated code
  expect(index.byApprovalId(rec.approvalId)!.status).toBe('needs_regate')
})

test('kill switch engaged after propose → confirm refuses to land (both channels)', async () => {
  const { handler, store, index, killSwitch } = makeDeps()
  await propose(handler)
  const rec = index.list()[0]!
  await killSwitch.engage() // freeze AFTER the proposal exists

  // GitHub merge during the freeze → not landed
  const gh = JSON.stringify({ action: 'closed', pull_request: { number: rec.prNumber, merged: true, head: { sha: rec.fixSha }, merged_by: { login: 'alice' } } })
  const r1 = await handler(new Request('http://x/webhook/github', { method: 'POST', headers: { 'x-hub-signature-256': ghSign(gh) }, body: gh }))
  expect((await r1.json()).landed).toBe(false)

  // Telegram approve during the freeze → not landed
  const tg = JSON.stringify({ callback_query: { id: 'cq9', data: `approve:${rec.approvalId}`, from: { username: 'oncall_jane' } } })
  await handler(new Request('http://x/telegram/callback', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'tg-secret' }, body: tg }))

  expect(store.listByClass(rec.classKey)).toHaveLength(0)
})

test('GitHub webhook with a bad signature → 401, no landing', async () => {
  const { handler, store, index } = makeDeps()
  await propose(handler)
  const rec = index.list()[0]!
  const payload = JSON.stringify({ action: 'closed', pull_request: { number: rec.prNumber, merged: true, head: { sha: rec.fixSha } } })
  const res = await handler(new Request('http://x/webhook/github', { method: 'POST', headers: { 'x-hub-signature-256': 'sha256=deadbeef' }, body: payload }))
  expect(res.status).toBe(401)
  expect(store.listByClass(rec.classKey)).toHaveLength(0)
})

test('channel 2 — Telegram approve confirms → the same human_approved landing', async () => {
  const { handler, store, index } = makeDeps()
  await propose(handler)
  const rec = index.list()[0]!

  const update = JSON.stringify({ callback_query: { id: 'cq1', data: `approve:${rec.approvalId}`, from: { id: 7, username: 'oncall_jane' } } })
  const res = await handler(new Request('http://x/telegram/callback', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'tg-secret' }, body: update }))
  expect(res.status).toBe(200)

  const landings = store.listByClass(rec.classKey)
  expect(landings).toHaveLength(1)
  expect(landings[0]!.applied_by).toBe('human_approved')
  expect(index.byApprovalId(rec.approvalId)!.status).toBe('confirmed')
})

test('channel 2 (Slack) — a signed approve action → the same human_approved landing', async () => {
  const { handler, store, index } = makeDeps()
  await propose(handler)
  const rec = index.list()[0]!
  const body = 'payload=' + encodeURIComponent(JSON.stringify({ actions: [{ value: `approve:${rec.approvalId}` }], user: { username: 'oncall_jane' } }))
  const ts = Math.floor(Date.now() / 1000).toString()
  const sig = 'v0=' + createHmac('sha256', 'slack-secret').update(`v0:${ts}:${body}`, 'utf8').digest('hex')
  const res = await handler(new Request('http://x/slack/callback', { method: 'POST', headers: { 'x-slack-request-timestamp': ts, 'x-slack-signature': sig }, body }))
  expect(res.status).toBe(200)
  expect(store.listByClass(rec.classKey)).toHaveLength(1)
  expect(store.listByClass(rec.classKey)[0]!.applied_by).toBe('human_approved')
})

test('Slack callback with a bad signature → 401, no landing', async () => {
  const { handler, store, index } = makeDeps()
  await propose(handler)
  const rec = index.list()[0]!
  const body = 'payload=' + encodeURIComponent(JSON.stringify({ actions: [{ value: `approve:${rec.approvalId}` }], user: {} }))
  const res = await handler(new Request('http://x/slack/callback', { method: 'POST', headers: { 'x-slack-request-timestamp': '1', 'x-slack-signature': 'v0=bad' }, body }))
  expect(res.status).toBe(401)
  expect(store.listByClass(rec.classKey)).toHaveLength(0)
})

test('channel 2 — Telegram reject → REJECTED, no landing', async () => {
  const { handler, store, index, approvals } = makeDeps()
  await propose(handler)
  const rec = index.list()[0]!

  const update = JSON.stringify({ callback_query: { id: 'cq2', data: `reject:${rec.approvalId}`, from: { username: 'oncall_jane' } } })
  await handler(new Request('http://x/telegram/callback', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'tg-secret' }, body: update }))

  expect(approvals.get(rec.approvalId)!.state).toBe('REJECTED')
  expect(store.listByClass(rec.classKey)).toHaveLength(0)
  expect(index.byApprovalId(rec.approvalId)!.status).toBe('rejected')
})

test('churn hold: a thrashing area is not auto-proposed into (floored to L0)', async () => {
  const t = Date.now()
  const { handler, index, publisher } = makeDeps({ churnActions: () => [t - 1000, t - 2000, t - 3000] }) // 3 in a burst
  const r = await propose(handler)
  expect(r.gate).toBe('CONFIRMED') // still diagnosed
  expect(index.list()).toHaveLength(0) // but NOT proposed — the area is held
  expect(publisher.published).toHaveLength(0)
})

test('kill switch off-path: with no repair deps, a CONFIRMED code diagnosis just diagnoses (no proposal)', async () => {
  const { deps } = makeDeps()
  const noRepair: AppDeps = { ...deps, repair: undefined }
  const handler = createFetchHandler(noRepair)
  const r = await propose(handler)
  expect(r.gate).toBe('CONFIRMED') // still diagnoses; simply never proposes — the v1 default
})
