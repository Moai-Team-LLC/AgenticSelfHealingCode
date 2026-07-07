/**
 * The deployable entry point. Reads config from the environment (populated from the gitignored
 * connectors/.env), wires the REAL adapters when their keys/inputs are present and falls back to fakes
 * otherwise, and serves the fetch handler. This module is thin glue over the tested runtime; it holds
 * no key literals (everything via @sho/adapters env helpers).
 *
 *   bun run packages/app/src/server.ts
 */

import { SQL } from 'bun'
import { criticalityFromMap } from '@sho/aggregation'
import { InMemoryIncidentMemory, PostgresIncidentMemory, type Query } from '@sho/incident-memory'
import { NotifyStore, PgNotifyStore, KillSwitch, PgKillSwitch, InMemoryAutoActionStore, PgAutoActionStore } from '@sho/orchestrator'
import { ApprovalQueue } from '@sho/hitl'
import { requiredMutationScore } from '@sho/trust-controller'
import type { RepairOutcome } from '@sho/loop-c'
import {
  optionalEnv, proposeWithClaude, TelegramNotifier, SlackNotifier, realFetch,
  claudeRepairProposer, gitWorktreeSandbox, sandboxedRepairAuthor, githubPublisher, makeVerifyGate,
} from '@sho/adapters'
import { GitBlameLog } from '@sho/rca-git'
import { createFetchHandler } from './http'
import { IncidentLog } from './oplog'
import { RepairIndex, PgRepairIndex } from './repairindex'
import type { AppDeps, DeliveryPayload, IncidentRecorder, NotifyGate, KillControl, RepairDeps } from './runtime'

function renderDelivery(p: DeliveryPayload): string {
  return `[${p.gate}] ${p.incidentId} — ${p.hypothesis}\ncorrelation: ${p.correlationState}${p.suspicious ? ' ⚠ suspicious telemetry' : ''}\n→ ${p.recommendedAction}`
}

/** The human-readable proposal notice: the error, the fix, the gate verdict, and the PR — with Approve/Reject. */
function renderProposal(o: RepairOutcome): string {
  const g = o.gate
  return [
    `🛠 Proposed fix — incident ${o.incidentId}`,
    o.hypothesis ? `Cause: ${o.hypothesis}` : '',
    o.staged?.summary ? `Fix: ${o.staged.summary}` : '',
    g ? `Gate: ${g.pass ? 'PASS ✅' : 'REJECT ❌'} · mutation ${g.signals.mutationScore.score ?? 'n/a'}≥${g.signals.mutationScore.threshold}` : '',
    o.changeRequest ? `PR: ${o.changeRequest.url}` : '',
    'Approve or reject below (or merge the PR).',
  ].filter(Boolean).join('\n')
}

export function buildServerDeps(now: () => number): AppDeps {
  // Real Postgres when DATABASE_URL is set (run `bun run migrate` first); fakes otherwise.
  const dbUrl = optionalEnv('DATABASE_URL')
  const releaseToken = optionalEnv('KILL_RELEASE_TOKEN')
  let mem: IncidentRecorder
  let notify: NotifyGate
  let killSwitch: KillControl
  let query: Query | undefined
  if (dbUrl) {
    const sql = new SQL(dbUrl)
    query = async (text, params) => (await sql.unsafe(text, (params ?? []) as never[])) as Record<string, unknown>[]
    mem = new PostgresIncidentMemory(query)
    notify = new PgNotifyStore(query) // durable notify_state CAS — no double-notify across restarts
    killSwitch = new PgKillSwitch(query, 30_000, releaseToken)
  } else {
    mem = new InMemoryIncidentMemory()
    notify = new NotifyStore()
    killSwitch = new KillSwitch(now(), 30_000, releaseToken)
  }
  const secret = optionalEnv('SIGNAL_SECRET')

  // Real LLM only when a key is present (rotated key, in connectors/.env — never in code).
  const apiKey = optionalEnv('ANTHROPIC_API_KEY')
  const propose = apiKey
    ? (input: Parameters<NonNullable<AppDeps['propose']>>[0]) => proposeWithClaude(input, { apiKey })
    : undefined

  // Real git-backed RCA grounding when RCA_GIT_REPO points at a checkout of the monitored service.
  const gitRepo = optionalEnv('RCA_GIT_REPO')
  const toolOverrides: AppDeps['toolOverrides'] = gitRepo ? { git: new GitBlameLog({ repo: gitRepo }) } : undefined

  // Real Telegram delivery + callback-answer when a token + chat are present.
  const tgToken = optionalEnv('TELEGRAM_BOT_TOKEN')
  const chat = optionalEnv('TELEGRAM_CHAT_ID')
  const deliverSinks: NonNullable<AppDeps['deliverSinks']> = []
  let answerCallback: AppDeps['answerCallback']
  let tg: TelegramNotifier | undefined
  if (tgToken && chat) {
    tg = new TelegramNotifier({ token: tgToken })
    deliverSinks.push((p) => { tg!.send({ chat, text: renderDelivery(p), buttons: [`ack:${p.incidentId}`] }, now()) })
    answerCallback = (id, text) => {
      void realFetch(`https://api.telegram.org/bot${tgToken}/answerCallbackQuery`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callback_query_id: id, text }),
      }).catch(() => {})
    }
  }

  // Real Slack delivery when a bot token + channel are present (approve/reject buttons on the proposal).
  const slackToken = optionalEnv('SLACK_BOT_TOKEN')
  const slackChannel = optionalEnv('SLACK_CHANNEL')
  const slack = slackToken ? new SlackNotifier({ token: slackToken }) : undefined

  // --- Loop C (human-confirmed repair): opt-in. Needs a rotated LLM key, a GitHub token + repo, a repo to run
  //     the sandbox against, AND an explicit acknowledgment that the sandbox runs inside the SECURITY §4
  //     container (REPAIR_ALLOW_UNTRUSTED_EXECUTION=true). Absent → diagnosis-only (the safe default). ---
  const ghToken = optionalEnv('GITHUB_TOKEN')
  const ghRepoFull = optionalEnv('GITHUB_REPO')
  const owner = ghRepoFull?.split('/')[0]
  const repoName = ghRepoFull?.split('/')[1]
  const repairRepo = optionalEnv('REPAIR_GIT_REPO') ?? gitRepo
  let repair: RepairDeps | undefined
  if (apiKey && ghToken && owner && repoName && repairRepo && optionalEnv('REPAIR_ALLOW_UNTRUSTED_EXECUTION') === 'true') {
    const testCmd = optionalEnv('REPAIR_TEST_CMD') ?? 'bun test'
    const store = query ? new PgAutoActionStore(query) : new InMemoryAutoActionStore()
    const index = query ? new PgRepairIndex(query) : new RepairIndex()
    const repairOwner = optionalEnv('REPAIR_OWNER') ?? 'oncall'
    repair = {
      author: sandboxedRepairAuthor({
        propose: claudeRepairProposer({ apiKey }),
        sandbox: gitWorktreeSandbox({ repo: repairRepo, baseRef: optionalEnv('REPAIR_BASE_REF') ?? 'HEAD', testCmd: testCmd.split(' '), allowUntrustedExecution: true }),
      }),
      runGate: makeVerifyGate({ testCmd }),
      publisher: githubPublisher({ token: ghToken, owner, repo: repoName, baseBranch: optionalEnv('GITHUB_BASE_BRANCH') }),
      approvals: new ApprovalQueue(),
      store,
      index,
      resolveAutonomy: (_c, _a, killed) => {
        const level = killed ? ('L0' as const) : ('L1' as const)
        return { level, tier: killed ? 1 : 2, requiredMutationScore: requiredMutationScore(level), accountableOwner: repairOwner }
      },
      routing: () => ({ team: optionalEnv('REPAIR_TEAM') ?? 'eng', primaryApprover: optionalEnv('REPAIR_APPROVER') ?? null, secondaryApprover: null }),
      churnActions: async (area) => (await store.listByArea(area)).map((a) => Date.parse(a.applied_at)),
      githubWebhookSecret: optionalEnv('GITHUB_WEBHOOK_SECRET'),
      notify: (o) => {
        if (o.status !== 'proposed' || !o.approvalId) return
        const text = renderProposal(o)
        const buttons = [`approve:${o.approvalId}`, `reject:${o.approvalId}`]
        if (tg && chat) tg.send({ chat, text, buttons }, now())
        if (slack && slackChannel) slack.send({ channel: slackChannel, text, buttons })
      },
    }
  }

  return {
    mem, notify, killSwitch, secret, criticality: criticalityFromMap({}), propose, toolOverrides, deliverSinks,
    oplog: new IncidentLog(),
    sentryClientSecret: optionalEnv('SENTRY_CLIENT_SECRET'),
    telegramWebhookSecret: optionalEnv('TELEGRAM_WEBHOOK_SECRET'),
    slackSigningSecret: optionalEnv('SLACK_SIGNING_SECRET'),
    answerCallback,
    repair,
  }
}

export function startServer(port = Number(optionalEnv('PORT') ?? 3000)) {
  const deps = buildServerDeps(() => Date.now())
  const handler = createFetchHandler(deps)
  // Bun global is available at runtime; guarded so importing this module never requires a running server.
  return (globalThis as { Bun?: { serve(o: unknown): unknown } }).Bun?.serve({ port, fetch: handler })
}

if (import.meta.main) {
  startServer()
  const on = (k: string) => (optionalEnv(k) ? 'on' : 'off')
  console.log(
    `AgenticSelfHealingCode — listening.  db=${on('DATABASE_URL')}  llm=${on('ANTHROPIC_API_KEY')}  ` +
    `telegram=${on('TELEGRAM_BOT_TOKEN')}  slack=${on('SLACK_BOT_TOKEN')}  sentry-native=${on('SENTRY_CLIENT_SECRET')}  ` +
    `git-rca=${on('RCA_GIT_REPO')}  repair=${optionalEnv('REPAIR_ALLOW_UNTRUSTED_EXECUTION') === 'true' ? 'armed' : 'off'}`,
  )
}
