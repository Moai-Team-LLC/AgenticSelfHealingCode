/**
 * ClaudeLlmClient — the real hypothesis proposer for @sho/loop-a, on the Anthropic Messages API.
 *
 * Design note: loop-a's `investigate` is SYNCHRONOUS and deterministic on purpose (the grounded-confidence
 * logic must not depend on an async model). So the (async) Claude call happens OUTSIDE investigate — the
 * app awaits `proposeWithClaude(...)` then feeds the pre-fetched proposal in via `new FakeLlmClient(proposal)`.
 * That keeps investigate pure while allowing a live model.
 *
 * The model's output is UNTRUSTED DATA (STRESS-TEST §7 / D7): it is parsed defensively into an LlmProposal
 * and NEVER executed or treated as an instruction; a malformed/empty response yields a safe fallback, not a
 * throw. The API key is passed in by the caller (read from env); this module never holds a literal key.
 */

import type { IncidentCandidate } from '@sho/contracts'
import type { LlmProposal } from '@sho/loop-a'
import type { FetchLike } from './env'
import { realFetch } from './env'

const FIX_CLASSES = new Set(['code', 'config', 'infra', 'data'])

export interface ClaudeOptions {
  apiKey: string
  model?: string
  fetchFn?: FetchLike
  maxTokens?: number
}

function buildPrompt(candidate: IncidentCandidate, evidenceSummary: string): string {
  return [
    'You are an SRE assistant. Propose ranked ROOT-CAUSE HYPOTHESES for the incident below.',
    'Return ONLY a JSON object, no prose, matching exactly:',
    '{"primary":{"statement":string,"fixClass":"code|config|infra|data","citedPath":string|null},"alternatives":[string,...]}',
    'Do NOT include any confidence score (it is ignored). Base hypotheses only on the evidence given.',
    '',
    `service: ${candidate.affected_service}`,
    `affected_paths: ${candidate.affected_paths.join(', ') || '(none)'}`,
    `fingerprint: ${candidate.fingerprint}`,
    `occurrences: ${candidate.occurrences}  shape: ${candidate.shape}`,
    `recent_deploys: ${candidate.recent_deploys.map((d) => d.deploy_id).join(', ') || '(none)'}`,
    `evidence: ${evidenceSummary}`,
  ].join('\n')
}

/** Extract the first balanced {...} JSON object from arbitrary model text. Returns null if none parses. */
function extractJson(text: string): unknown {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') { depth--; if (depth === 0) { try { return JSON.parse(text.slice(start, i + 1)) } catch { return null } } }
  }
  return null
}

function coerceProposal(parsed: unknown, candidate: IncidentCandidate): LlmProposal {
  const fallback: LlmProposal = {
    primary: { statement: `Unclassified regression in ${candidate.affected_service}`, fixClass: 'code', citedPath: candidate.affected_paths[0] },
    alternatives: [],
  }
  if (!parsed || typeof parsed !== 'object') return fallback
  const o = parsed as Record<string, unknown>
  const p = (o.primary && typeof o.primary === 'object' ? o.primary : {}) as Record<string, unknown>
  const statement = typeof p.statement === 'string' && p.statement.trim() ? p.statement : fallback.primary.statement
  const fixClass = (typeof p.fixClass === 'string' && FIX_CLASSES.has(p.fixClass) ? p.fixClass : 'code') as LlmProposal['primary']['fixClass']
  const citedPath = typeof p.citedPath === 'string' ? p.citedPath : undefined
  const alternatives = Array.isArray(o.alternatives) ? o.alternatives.filter((a): a is string => typeof a === 'string').slice(0, 5) : []
  return { primary: { statement, fixClass, citedPath }, alternatives }
}

export async function proposeWithClaude(
  input: { candidate: IncidentCandidate; evidenceSummary: string },
  opts: ClaudeOptions,
): Promise<LlmProposal> {
  const f = opts.fetchFn ?? realFetch
  const res = await f('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: opts.model ?? 'claude-opus-4-8',
      max_tokens: opts.maxTokens ?? 1024,
      messages: [{ role: 'user', content: buildPrompt(input.candidate, input.evidenceSummary) }],
    }),
  })
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`)
  const json = (await res.json()) as { content?: { type?: string; text?: string }[] }
  const text = json.content?.find((b) => b.type === 'text')?.text ?? ''
  return coerceProposal(extractJson(text), input.candidate)
}
