/**
 * AplTelemetry — SHO's TelemetrySink emitted in APL's OTel contract, so APL (the org's
 * agent-observability/eval product) can ingest, cluster, and scorecard SHO's agents.
 *
 * SHO's Loop A is the observed "agent": every TelemetryEvent becomes ONE RawTrace whose
 * root is an `invoke_agent` span carrying agent identity + the per-invocation apl.* facts,
 * exactly the way APL's own SDK stamps them (apl/packages/core/src/sdk.ts). Two contract
 * decisions from APL's contract.ts are honored here:
 *   1. Operation, not span name — `gen_ai.operation.name` is canonical; span names are
 *      `invoke_agent <agent>` / `chat <model>` / `execute_tool <tool>`.
 *   2. Identity on the Resource — apl.tenant_id/apl.product_id live on the Resource;
 *      agent_id/agent_version + per-invocation facts live on the invoke_agent span.
 *
 * Kind mapping (chosen from the REAL contract vocabulary, not invented):
 *   rca_outcome      → apl.outcome on the root (OutcomeLabel/OutcomeEventKind → APL Outcome;
 *                      provisional_human_confirmed additionally stamps apl.human_feedback
 *                      "thumbs:up" — that label IS a human judgment in SHO's flow).
 *   harm             → apl.outcome="fail" + apl.keep=true (harm is a bad, must-keep trace).
 *   trust_transition → demotion = autonomy pulled back to humans = apl.outcome="escalated"
 *                      (+keep); promotion = earned trust = "success"; detail in
 *                      apl.decision_reason. No apl.trust attr exists — this is the honest fit.
 *   gate_result      → child `execute_tool verification_gate` span (the gate is a tool the
 *                      loop runs); gate detail under sho.gate.* (APL preserves unknown attrs).
 *   llm_cost         → child `chat <model>` span with the GenAI usage attributes.
 *   mttr_split       → child framework-internal span (no canonical operation — APL keeps it
 *                      verbatim, per contract.ts FR-INTEG-2), numeric splits under sho.mttr.*.
 *
 * The exporter is INJECTED — this package has zero runtime dependency on the APL repo. The
 * attribute names below are copied verbatim from apl/packages/core/src/contract.ts;
 * verify-live.ts asserts the copies against the real constants and round-trips emitted
 * traces through APL's real normalizeGenAI/validateTrace.
 */

import type { TelemetryEvent, TelemetrySink } from '@sho/contracts'

// ── APL's OTel-ish wire shape (duck-typed copy of contract.ts RawSpan/RawTrace) ──

export type AplAttrValue = string | number | boolean
export type AplAttributes = Record<string, AplAttrValue>

export interface AplRawSpan {
  spanId: string
  parentSpanId: string | null
  name: string
  attributes: AplAttributes
}

export interface AplRawTrace {
  resource: AplAttributes
  spans: AplRawSpan[]
}

/** The injected exporter: receives the OTel-shaped traces, owns the transport. */
export type AplExporter = (traces: AplRawTrace[]) => void | Promise<void>

// ── Attribute names copied VERBATIM from apl/packages/core/src/contract.ts ──

export const GEN_AI = {
  OPERATION_NAME: 'gen_ai.operation.name',
  REQUEST_MODEL: 'gen_ai.request.model',
  PROVIDER_NAME: 'gen_ai.provider.name',
  USAGE_INPUT_TOKENS: 'gen_ai.usage.input_tokens',
  USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
  TOOL_NAME: 'gen_ai.tool.name',
} as const

export const APL = {
  TENANT_ID: 'apl.tenant_id',
  PRODUCT_ID: 'apl.product_id',
  AGENT_ID: 'apl.agent_id',
  AGENT_VERSION: 'apl.agent_version',
  TASK_ID: 'apl.task_id',
  OUTCOME: 'apl.outcome',
  HUMAN_FEEDBACK: 'apl.human_feedback',
  DECISION_REASON: 'apl.decision_reason',
  KEEP: 'apl.keep',
} as const

/** Canonical operations (contract.ts AplOperation values). */
export const OPERATION = {
  INVOKE_AGENT: 'invoke_agent',
  CHAT: 'chat',
  EXECUTE_TOOL: 'execute_tool',
} as const

/** APL sdk.ts Outcome vocabulary. */
export type AplOutcome = 'success' | 'fail' | 'escalated' | 'unknown'

// ── SHO outcome vocabulary → APL Outcome (both @sho/contracts vocabularies) ──
// OutcomeLabel: proposed|applied|provisional_human_confirmed|confirmed_good|recurred|reverted|wrong_rca|superseded
// OutcomeEventKind: applied|recurrence|spawn|spawn_contested|revert|matured
const RCA_TO_APL_OUTCOME: Record<string, AplOutcome> = {
  confirmed_good: 'success',
  provisional_human_confirmed: 'success',
  matured: 'success',
  recurred: 'fail',
  recurrence: 'fail',
  reverted: 'fail',
  revert: 'fail',
  wrong_rca: 'fail',
  spawn: 'fail',
  spawn_contested: 'fail',
  proposed: 'escalated', // Loop A proposes, a human decides — that IS escalation
  applied: 'unknown', // landed but not yet judged
  superseded: 'unknown',
}

const TRUST_RANK: Record<string, number> = { L0: 0, L1: 1, L2: 2, L3: 3 }

const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const asNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const asBool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)

export interface AplTelemetryOptions {
  /** Resource identity — MANDATORY_RESOURCE_ATTRS in APL's contract. */
  tenantId: string
  productId: string
  exporter: AplExporter
  /** The observed agent (SHO's RCA loop). */
  agentId?: string // default 'sho-loop-a'
  agentVersion?: string // default '0.0.0'
}

export class AplTelemetry implements TelemetrySink {
  private seq = 0
  constructor(private readonly opts: AplTelemetryOptions) {}

  emit(e: TelemetryEvent): void | Promise<void> {
    return this.opts.exporter([this.toTrace(e)])
  }

  private nextId(): string {
    return `span-${this.seq++}`
  }

  private toTrace(e: TelemetryEvent): AplRawTrace {
    const agentId = this.opts.agentId ?? 'sho-loop-a'
    const root: AplRawSpan = {
      spanId: this.nextId(),
      parentSpanId: null,
      name: `${OPERATION.INVOKE_AGENT} ${agentId}`,
      attributes: {
        [GEN_AI.OPERATION_NAME]: OPERATION.INVOKE_AGENT,
        [APL.AGENT_ID]: agentId,
        [APL.AGENT_VERSION]: this.opts.agentVersion ?? '0.0.0',
        // SHO's unit of agent work is the incident — that is the invocation/task.
        [APL.TASK_ID]: e.incidentId ?? e.classKey ?? `${e.kind}@${e.at}`,
        'sho.event_kind': e.kind,
        'sho.at': e.at,
      },
    }
    if (e.classKey !== undefined) root.attributes['sho.class_key'] = e.classKey
    const spans: AplRawSpan[] = [root]

    switch (e.kind) {
      case 'harm': {
        root.attributes[APL.OUTCOME] = 'fail'
        root.attributes[APL.KEEP] = true // sdk.ts: fail/escalated flag the tail-sampling keep-hint
        const reason = asStr(e.data['reason'])
        root.attributes[APL.DECISION_REASON] = reason !== undefined ? `harm: ${reason}` : 'harm'
        break
      }
      case 'trust_transition': {
        const from = asStr(e.data['from'])
        const to = asStr(e.data['to'])
        const fromRank = from !== undefined ? TRUST_RANK[from] : undefined
        const toRank = to !== undefined ? TRUST_RANK[to] : undefined
        let outcome: AplOutcome = 'unknown'
        if (fromRank !== undefined && toRank !== undefined && toRank !== fromRank) {
          outcome = toRank < fromRank ? 'escalated' : 'success'
        }
        root.attributes[APL.OUTCOME] = outcome
        if (outcome === 'escalated') root.attributes[APL.KEEP] = true
        const reason = asStr(e.data['reason'])
        root.attributes[APL.DECISION_REASON] =
          `trust_transition ${from ?? '?'}->${to ?? '?'}${reason !== undefined ? `: ${reason}` : ''}`
        break
      }
      case 'rca_outcome': {
        const label = asStr(e.data['label']) ?? asStr(e.data['kind'])
        const outcome = (label !== undefined ? RCA_TO_APL_OUTCOME[label] : undefined) ?? 'unknown'
        root.attributes[APL.OUTCOME] = outcome
        if (outcome === 'fail' || outcome === 'escalated') root.attributes[APL.KEEP] = true
        if (label === 'provisional_human_confirmed') root.attributes[APL.HUMAN_FEEDBACK] = 'thumbs:up'
        if (label !== undefined) root.attributes['sho.outcome_label'] = label
        const reason = asStr(e.data['hypothesis']) ?? asStr(e.data['reason'])
        if (reason !== undefined) root.attributes[APL.DECISION_REASON] = reason
        break
      }
      case 'gate_result': {
        const child: AplRawSpan = {
          spanId: this.nextId(),
          parentSpanId: root.spanId,
          name: `${OPERATION.EXECUTE_TOOL} verification_gate`,
          attributes: {
            [GEN_AI.OPERATION_NAME]: OPERATION.EXECUTE_TOOL,
            [GEN_AI.TOOL_NAME]: 'verification_gate',
          },
        }
        const pass = asBool(e.data['pass'])
        if (pass !== undefined) child.attributes['sho.gate.pass'] = pass
        const moduleArea = asStr(e.data['moduleArea'])
        if (moduleArea !== undefined) child.attributes['sho.gate.module_area'] = moduleArea
        const reason = asStr(e.data['reason'])
        if (reason !== undefined) child.attributes['sho.gate.reason'] = reason
        if (pass === false) root.attributes[APL.KEEP] = true
        spans.push(child)
        break
      }
      case 'llm_cost': {
        const model = asStr(e.data['model']) ?? 'unknown'
        const child: AplRawSpan = {
          spanId: this.nextId(),
          parentSpanId: root.spanId,
          name: `${OPERATION.CHAT} ${model}`,
          attributes: {
            [GEN_AI.OPERATION_NAME]: OPERATION.CHAT,
            [GEN_AI.REQUEST_MODEL]: model,
          },
        }
        const provider = asStr(e.data['provider'])
        if (provider !== undefined) child.attributes[GEN_AI.PROVIDER_NAME] = provider
        const inTok = asNum(e.data['inputTokens']) ?? asNum(e.data['input_tokens'])
        if (inTok !== undefined) child.attributes[GEN_AI.USAGE_INPUT_TOKENS] = inTok
        const outTok = asNum(e.data['outputTokens']) ?? asNum(e.data['output_tokens'])
        if (outTok !== undefined) child.attributes[GEN_AI.USAGE_OUTPUT_TOKENS] = outTok
        const costUsd = asNum(e.data['costUsd']) ?? asNum(e.data['cost_usd'])
        if (costUsd !== undefined) child.attributes['sho.cost_usd'] = costUsd
        spans.push(child)
        break
      }
      case 'mttr_split': {
        // No canonical GenAI operation exists for an ops timing metric — emit it as a
        // framework-internal span (operation=null after normalize), which APL preserves.
        const child: AplRawSpan = {
          spanId: this.nextId(),
          parentSpanId: root.spanId,
          name: 'mttr_split',
          attributes: {},
        }
        for (const [k, v] of Object.entries(e.data)) {
          const n = asNum(v)
          if (n !== undefined) child.attributes[`sho.mttr.${k}`] = n
        }
        spans.push(child)
        break
      }
    }

    return {
      resource: {
        [APL.TENANT_ID]: this.opts.tenantId,
        [APL.PRODUCT_ID]: this.opts.productId,
      },
      spans,
    }
  }
}
