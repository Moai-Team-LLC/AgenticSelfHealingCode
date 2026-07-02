/**
 * Live verification for @sho/adapter-agenticmind — two independently gated rungs:
 *
 *  1. REAL SOURCE (no server): import AgenticMind's actual mcp-tools.ts from the local clone and
 *     validate every payload this adapter emits against the REAL zod input schemas, and pin
 *     MCP_CONTRACT_VERSION. Gated on the clone existing (AGENTICMIND_REPO overrides the path).
 *  2. REAL SERVER: gated on AGENTICMIND_MCP_URL (+ optional AGENTICMIND_MCP_TOKEN). Speaks MCP
 *     streamable HTTP (initialize → tools/list → tools/call) and drives the adapter through it.
 *     Read-only by default; set AGENTICMIND_LIVE_WRITE=1 to run the full record→label→retrieve
 *     cycle against the live knowledge base.
 *
 * Run: bun packages/adapter-agenticmind/verify-live.ts   (skips cleanly when nothing is configured)
 */

import { existsSync } from 'node:fs'
import { AgenticMindIncidentMemory, AGENTICMIND_MCP_CONTRACT_VERSION, type McpCall } from './src/index'
import type { WhyTrace } from '@sho/contracts'
import type { IncidentRecord } from '@sho/incident-memory'

const REPO = process.env.AGENTICMIND_REPO ?? '/Users/duchenchuk/Documents/ClaudeCode/agenticmind-org'
const MCP_URL = process.env.AGENTICMIND_MCP_URL
const MCP_TOKEN = process.env.AGENTICMIND_MCP_TOKEN
const LIVE_WRITE = process.env.AGENTICMIND_LIVE_WRITE === '1'

let failures = 0
const ok = (name: string): void => console.log(`  ok  ${name}`)
const fail = (name: string, detail: string): void => {
  failures++
  console.error(`  FAIL ${name}: ${detail}`)
}

const sampleIncident: IncidentRecord = {
  id: 'sho-verify-i1',
  fingerprint: 'fp-verify',
  symptomSignature: 'TypeError::cannot read price of <id>',
  moduleArea: 'src/checkout',
  signalText: 'TypeError cannot read price of undefined',
  firstSeenMs: 0,
}
const sampleTrace: WhyTrace = {
  incidentId: 'sho-verify-i1',
  hypothesis: 'deploy removed the null guard',
  alternatives: ['partial upstream rows'],
  confidence: { reproduced: true, explainsAllOccurrences: true, affectedPathInDeployDiff: true, stepVsSlopeConsistent: null },
  correlationState: 'deploy_linked',
  affectedComponents: ['src/checkout/price.ts'],
  fixClass: 'code',
  recommendedAction: 'restore the null guard',
  suspiciousContentFlag: false,
  similarIncidents: [],
}

/** Drive the whole adapter surface through a transport; returns nothing (asserts inside transport). */
async function exercise(call: McpCall): Promise<void> {
  const mem = new AgenticMindIncidentMemory(call)
  const { materialId } = await mem.recordIncident(sampleIncident, sampleTrace, { language: 'english' })
  await mem.askGlobal('how did we fix the checkout price TypeError?', { incidentId: sampleIncident.id, intent: 'RCA precedent' })
  await mem.setOutcomeLabel(sampleIncident.id, 'confirmed_good')
  await mem.setOutcomeLabel(sampleIncident.id, 'reverted')
  const r = await mem.retrieveSimilar('TypeError price undefined checkout', 5)
  console.log(`  (exercised: material=${materialId} exemplars=${r.exemplars.length} antiPatterns=${r.antiPatterns.length})`)
}

// ── rung 1: validate emitted payloads against the REAL zod schemas ───────────

async function rung1(): Promise<void> {
  const toolsPath = `${REPO}/packages/shared/src/lib/knowledge/mcp-tools.ts`
  if (!existsSync(toolsPath)) {
    console.log(`rung 1 SKIPPED: AgenticMind clone not found at ${REPO} (set AGENTICMIND_REPO)`)
    return
  }
  console.log(`rung 1: validating adapter payloads against REAL schemas in ${toolsPath}`)
  const real = (await import(toolsPath)) as {
    MCP_CONTRACT_VERSION: string
    KNOWLEDGE_MCP_TOOLS: readonly { name: string; inputSchema: { safeParse(v: unknown): { success: boolean; error?: unknown } } }[]
  }

  if (real.MCP_CONTRACT_VERSION === AGENTICMIND_MCP_CONTRACT_VERSION) ok(`contract version pinned: ${real.MCP_CONTRACT_VERSION}`)
  else fail('contract version', `adapter targets ${AGENTICMIND_MCP_CONTRACT_VERSION}, repo has ${real.MCP_CONTRACT_VERSION} — re-read CONTRACT.md`)

  const schemas = new Map(real.KNOWLEDGE_MCP_TOOLS.map((t) => [t.name, t.inputSchema]))
  const canned: Record<string, unknown> = {
    kl_ingest: { materialId: 'mat-1', title: 't', chunkCount: 1, entities: 0, relations: 0 },
    kl_search: { query: 'q', hits: [{ materialId: 'mat-1', title: 'SHO incident sho-verify-i1 | src/checkout | TypeError::cannot read price of <id>', snippet: 's', score: 0.9 }] },
    kl_ask_global: { answer: 'a', citations: [], retrievalMs: 1, generationMs: 1, model: 'm', servedBy: 'chunks', telemetryId: 'ask-1' },
    kl_signal: { ok: true, askId: 'ask-1', signal: 'downstream_success', strength: 1 },
    mem_write: { id: 'b1', revised: false },
    mem_recall: { beliefs: [{ id: 'b1', actorUuid: 'a', subject: 'sho-verify-i1', predicate: 'sho:outcome', object: 'confirmed_good', confidence: 1 }] },
  }
  let calls = 0
  const validating: McpCall = async (tool, args) => {
    calls++
    const schema = schemas.get(tool)
    if (!schema) fail(tool, 'tool not present in the real KNOWLEDGE_MCP_TOOLS registry')
    else {
      const parsed = schema.safeParse(args)
      if (parsed.success) ok(`${tool} args pass the REAL input schema`)
      else fail(tool, `real schema rejected args: ${String(parsed.error)} args=${JSON.stringify(args)}`)
    }
    return canned[tool]
  }
  await exercise(validating)
  console.log(`rung 1 done: ${calls} tool calls validated against real source`)
}

// ── rung 2: real MCP server over streamable HTTP ─────────────────────────────

interface JsonRpcResponse { id?: number; result?: unknown; error?: { message?: string } }

async function rpc(url: string, sessionId: string | null, body: Record<string, unknown>): Promise<{ res: Response; msg: JsonRpcResponse | null }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(MCP_TOKEN ? { authorization: `Bearer ${MCP_TOKEN}` } : {}),
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
  }
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', ...body }) })
  const ct = res.headers.get('content-type') ?? ''
  if (res.status === 202 || res.status === 204) return { res, msg: null } // notification accepted
  const text = await res.text()
  if (ct.includes('text/event-stream')) {
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue
      try {
        const parsed = JSON.parse(line.slice(5).trim()) as JsonRpcResponse
        if (parsed.id !== undefined || parsed.result !== undefined || parsed.error !== undefined) return { res, msg: parsed }
      } catch { /* keep scanning */ }
    }
    return { res, msg: null }
  }
  try { return { res, msg: JSON.parse(text) as JsonRpcResponse } } catch { return { res, msg: null } }
}

async function rung2(): Promise<void> {
  if (!MCP_URL) {
    console.log('rung 2 SKIPPED: AGENTICMIND_MCP_URL not set')
    return
  }
  console.log(`rung 2: exercising real server at ${MCP_URL}`)
  let id = 0
  const init = await rpc(MCP_URL, null, {
    id: ++id,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'sho-adapter-agenticmind-verify', version: '0.0.0' } },
  })
  const session = init.res.headers.get('mcp-session-id')
  const serverInfo = (init.msg?.result as { serverInfo?: { version?: string } } | undefined)?.serverInfo
  if (init.msg?.error) return fail('initialize', String(init.msg.error.message))
  ok(`initialized (serverInfo.version=${serverInfo?.version ?? '?'} session=${session !== null})`)
  if (serverInfo?.version !== undefined && !serverInfo.version.startsWith('1.')) {
    fail('contract line', `server is on ${serverInfo.version}, adapter targets ${AGENTICMIND_MCP_CONTRACT_VERSION} (1.x)`)
  }
  await rpc(MCP_URL, session, { method: 'notifications/initialized' })

  const list = await rpc(MCP_URL, session, { id: ++id, method: 'tools/list', params: {} })
  const tools = ((list.msg?.result as { tools?: { name: string }[] } | undefined)?.tools ?? []).map((t) => t.name)
  for (const needed of ['kl_search', 'kl_ask_global', 'kl_ingest', 'kl_signal', 'mem_write', 'mem_recall']) {
    if (tools.includes(needed)) ok(`server exposes ${needed}`)
    else fail('tools/list', `server missing ${needed} (have: ${tools.join(', ')})`)
  }

  const liveCall: McpCall = async (tool, args) => {
    const { msg } = await rpc(MCP_URL, session, { id: ++id, method: 'tools/call', params: { name: tool, arguments: args } })
    if (msg?.error) throw new Error(`${tool}: ${String(msg.error.message)}`)
    const result = msg?.result as { structuredContent?: unknown; content?: { type: string; text?: string }[] } | undefined
    if (result?.structuredContent !== undefined) return result.structuredContent
    const text = result?.content?.find((c) => c.type === 'text')?.text
    if (text !== undefined) { try { return JSON.parse(text) } catch { return text } }
    return result
  }

  const mem = new AgenticMindIncidentMemory(liveCall)
  const r = await mem.retrieveSimilar('TypeError price undefined checkout', 3)
  ok(`live kl_search+join: exemplars=${r.exemplars.length} antiPatterns=${r.antiPatterns.length}`)

  if (LIVE_WRITE) {
    await exercise(liveCall)
    ok('live full record→label→retrieve cycle')
  } else {
    console.log('  (write cycle skipped — set AGENTICMIND_LIVE_WRITE=1 to run kl_ingest/mem_write/kl_signal live)')
  }
}

await rung1()
await rung2()
if (failures > 0) {
  console.error(`verify-live: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('verify-live: all configured rungs green')
