/**
 * ClaudeRepairProposer — the LLM half of the sandboxed repair worker, on the Anthropic Messages API. It is
 * the direct analogue of proposeWithClaude (loop-a): the model's output is UNTRUSTED DATA (D7), parsed
 * defensively into a RepairProposal and NEVER executed here; a malformed/empty response yields null (a
 * decline), never a throw. The API key is passed in by the caller (read from env); this module never holds a
 * literal key. Default model is claude-opus-4-8 (D1), overridable.
 *
 * This is a single-shot proposer over the files the sandbox read for it. The production repair worker is the
 * agentic form (Claude Agent SDK with the §3.3 least-privilege tool allow-list — code_search, git_read,
 * sandbox_exec, git_write_branch on non-protected paths, pr_open); this proposer is the reasoning step of
 * that worker reduced to one governed call, which keeps the grounded-repro cycle (repair-author.ts) in charge.
 */

import type { RepairContext } from '@sho/loop-c'
import type { RepairProposal, RepairProposer, RepoFile } from './repair-author'
import type { FetchLike } from './env'
import { realFetch } from './env'

export interface ClaudeRepairOptions {
  apiKey: string
  model?: string
  fetchFn?: FetchLike
  maxTokens?: number
  /** cap each file's content sent to the model (context hygiene). Default 6000 chars. */
  maxFileChars?: number
}

function buildPrompt(ctx: RepairContext, files: RepoFile[], maxFileChars: number): string {
  const t = ctx.whyTrace
  const fileBlocks = files
    .map((f) => `--- FILE: ${f.path} ---\n${f.content.slice(0, maxFileChars)}`)
    .join('\n\n')
  return [
    'You are a careful software-repair agent. Produce the SMALLEST safe code fix for the diagnosed bug,',
    'plus a regression test that FAILS on the current (buggy) code and PASSES once your fix is applied.',
    'Return ONLY a JSON object, no prose, matching exactly:',
    '{"summary":string,"testPath":string,"testSource":string,"diff":string,"sourceFiles":[string,...],"touchedPaths":[string,...]}',
    '- "diff" is a valid unified diff in standard git format (with a/ and b/ path prefixes); `git apply` must succeed.',
    '- "testSource" is the full contents of a new regression test at "testPath".',
    '- "sourceFiles" are the module files your diff changes; "touchedPaths" is every path you write (diff + test).',
    '- Do NOT touch auth, billing, infra, migrations, CI config, or secrets. Do NOT add dependencies.',
    '- Do NOT include a confidence score (it is ignored; correctness is decided by running the test + the gate).',
    '',
    `Grounded hypothesis: ${t.hypothesis}`,
    `Affected components: ${t.affectedComponents.join(', ') || '(none)'}`,
    `Correlation: ${t.correlationState}  fixClass: ${t.fixClass}`,
    `Recommended action: ${t.recommendedAction}`,
    '',
    fileBlocks || '(no file contents were available)',
  ].join('\n')
}

/** Extract the first balanced {...} JSON object from arbitrary model text. Returns null if none parses. */
function extractJson(text: string): unknown {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)) } catch { return null }
      }
    }
  }
  return null
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** Coerce parsed model output → RepairProposal, or null when it is not a usable candidate (a decline). */
function coerce(parsed: unknown): RepairProposal | null {
  if (!parsed || typeof parsed !== 'object') return null
  const o = parsed as Record<string, unknown>
  const summary = typeof o.summary === 'string' ? o.summary : ''
  const diff = typeof o.diff === 'string' ? o.diff : ''
  const testPath = typeof o.testPath === 'string' ? o.testPath : ''
  const testSource = typeof o.testSource === 'string' ? o.testSource : ''
  const sourceFiles = asStringArray(o.sourceFiles)
  let touchedPaths = asStringArray(o.touchedPaths)
  // A candidate is only usable if it has a diff, a regression test, and named source files.
  if (!diff.trim() || !testPath.trim() || !testSource.trim() || sourceFiles.length === 0) return null
  // touchedPaths must at least include the test + the source files (so the protected-path check is honest).
  const union = new Set([...touchedPaths, ...sourceFiles, testPath])
  touchedPaths = [...union]
  return { summary: summary || 'automated repair', diff, testPath, testSource, sourceFiles, touchedPaths }
}

/** Build a RepairProposer backed by Claude. */
export function claudeRepairProposer(opts: ClaudeRepairOptions): RepairProposer {
  const f = opts.fetchFn ?? realFetch
  const maxFileChars = opts.maxFileChars ?? 6000
  return async (ctx, files) => {
    const res = await f('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: opts.model ?? 'claude-opus-4-8',
        max_tokens: opts.maxTokens ?? 4096,
        messages: [{ role: 'user', content: buildPrompt(ctx, files, maxFileChars) }],
      }),
    })
    if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`)
    const json = (await res.json()) as { content?: { type?: string; text?: string }[] }
    const text = json.content?.find((b) => b.type === 'text')?.text ?? ''
    return coerce(extractJson(text))
  }
}
