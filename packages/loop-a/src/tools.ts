/**
 * Loop A tool inventory (LOOP-A-SPEC §3). EVERY tool here is READ-ONLY — this is the primary structural
 * defense (Tier 1, attack D7): a successful log-borne prompt injection reaches only these read tools and
 * an egress-denied read-only sandbox, so it has nothing to weaponize. There is deliberately no write/exec
 * tool in this file and none is exported from the package.
 *
 * Everything is behind an interface with a fake/in-memory default so the decision logic is testable NOW
 * (no live LLM, no network, no git, no sandbox). Real adapters are thin code over an injected client.
 */

import type { IncidentCandidate } from '@sho/contracts'

// ── LLM client (the agent's narration; NEVER the source of confidence numbers) ──────────────────────

/** A single ranked hypothesis the model proposes. Confidence is NOT taken from the model (§4). */
export interface Hypothesis {
  statement: string
  fixClass: 'code' | 'config' | 'infra' | 'data'
  /** the file/range the hypothesis implicates — used by mechanical G3 hunk-overlap, not trusted as truth. */
  citedPath?: string
}

export interface LlmProposal {
  primary: Hypothesis
  alternatives: string[]
}

/**
 * The investigation model. Its job is to PROPOSE ranked hypotheses from tool evidence; it is explicitly
 * NOT asked for a confidence number (self-reported LLM confidence is ~uncorrelated with correctness,
 * STRESS-TEST §2). Injected so tests run with a deterministic fake and prod swaps a real Agent-SDK runner.
 */
export interface LlmClient {
  propose(input: { candidate: IncidentCandidate; evidenceSummary: string }): LlmProposal
}

/** Deterministic fake: returns a fixed hypothesis derived from the candidate. No network, no model. */
export class FakeLlmClient implements LlmClient {
  constructor(private readonly proposal?: LlmProposal) {}
  propose(input: { candidate: IncidentCandidate; evidenceSummary: string }): LlmProposal {
    if (this.proposal) return this.proposal
    const path = input.candidate.affected_paths[0]
    return {
      primary: {
        statement: `Regression in ${input.candidate.affected_service} affecting ${path ?? 'unknown path'}`,
        fixClass: 'code',
        citedPath: path,
      },
      alternatives: ['Upstream dependency degradation', 'Coincidental deploy, unrelated cause'],
    }
  }
}

// ── Read-only RCA tools (§3 tool inventory). All results are DATA, never instructions. ──────────────

/** code.search — semantic/full-text over an indexed repo. Read-only. */
export interface CodeSearchTool {
  search(input: { query: string; kind: 'semantic' | 'text' }): { path: string; line: number; snippet: string }[]
}

/** git.blame + git.log — read-only history. `diff` returns the hunks of a deploy sha-range. */
export interface GitBlameLogTool {
  blame(input: { path: string; range?: [number, number] }): { sha: string; author: string; ts: string }[]
  log(input: { path: string; follow?: boolean; since?: string }): { sha: string; ts: string; summary: string }[]
  /** diff of a deploy sha-range: the set of file paths (and hunks) the deploy actually touched. */
  diff(input: { shaRange: string }): { path: string; hunk: string }[]
}

/**
 * trace.correlate — the OTel-backed occurrence matcher (§3, G2/G7). Given the hypothesis's failing
 * signature it returns, over a SAMPLE of occurrences, how many matched and how many pinned to one span.
 */
export interface TraceCorrelateTool {
  correlate(input: { fingerprint: string; matchSignature?: string; sample: number }): {
    sampled: number
    /** occurrences whose trace matched the hypothesis's failing signature (feeds mechanical G2). */
    matched: number
    /** occurrences pinning to a SINGLE span / code location (feeds mechanical G7, deploy-independent). */
    localizedToOneSpan: number
  }
}

/** memory.retrieve — outcome-weighted retrieval from Incident Memory (§6). Read-only. */
export interface MemoryRetrieveTool {
  retrieve(input: { query: string; lineage?: string[] }): {
    exemplars: { incidentId: string; outcomeLabel: string; resolutionRef?: string }[]
    antiPatterns: { incidentId: string; outcomeLabel: string; resolutionRef?: string }[]
  }
}

export interface ReplaySpec {
  kind: 'captured_request' | 'failing_input' | 'synthetic_load'
  ref: string
}

/**
 * repro.sandbox — OPTIONAL read-only reproduction harness (§1/§3). Ephemeral container, default-deny
 * egress, no repo-write token, no prod credentials. Produces a boolean, not a fix. Absent for services
 * with no harness (then G1 is null and grounding must come from a deploy path or G7).
 */
export interface SandboxReproTool {
  reproduce(input: { sha: string; replay: ReplaySpec }): { reproduced: boolean }
}

/** The injected read-only tool bundle handed to an investigation. `repro` is optional by design (§1). */
export interface RcaTools {
  llm: LlmClient
  code: CodeSearchTool
  git: GitBlameLogTool
  trace: TraceCorrelateTool
  memory: MemoryRetrieveTool
  repro?: SandboxReproTool
}

// ── In-memory fakes (deterministic; the default so decision logic is testable without infra) ────────

export class FakeCodeSearch implements CodeSearchTool {
  constructor(private readonly results: { path: string; line: number; snippet: string }[] = []) {}
  search(): { path: string; line: number; snippet: string }[] {
    return this.results
  }
}

export class FakeGitBlameLog implements GitBlameLogTool {
  constructor(private readonly diffPaths: { path: string; hunk: string }[] = []) {}
  blame(): { sha: string; author: string; ts: string }[] {
    return []
  }
  log(): { sha: string; ts: string; summary: string }[] {
    return []
  }
  diff(): { path: string; hunk: string }[] {
    return this.diffPaths
  }
}

export class FakeTraceCorrelate implements TraceCorrelateTool {
  constructor(private readonly result: { sampled: number; matched: number; localizedToOneSpan: number }) {}
  correlate(input: { sample: number }): { sampled: number; matched: number; localizedToOneSpan: number } {
    // Fake respects the requested sample size but never exceeds what it "has".
    const sampled = Math.min(input.sample, this.result.sampled)
    const scale = this.result.sampled === 0 ? 0 : sampled / this.result.sampled
    return {
      sampled,
      matched: Math.round(this.result.matched * scale),
      localizedToOneSpan: Math.round(this.result.localizedToOneSpan * scale),
    }
  }
}

export class FakeMemoryRetrieve implements MemoryRetrieveTool {
  constructor(
    private readonly result: {
      exemplars: { incidentId: string; outcomeLabel: string; resolutionRef?: string }[]
      antiPatterns: { incidentId: string; outcomeLabel: string; resolutionRef?: string }[]
    } = { exemplars: [], antiPatterns: [] },
  ) {}
  retrieve(): {
    exemplars: { incidentId: string; outcomeLabel: string; resolutionRef?: string }[]
    antiPatterns: { incidentId: string; outcomeLabel: string; resolutionRef?: string }[]
  } {
    return this.result
  }
}

export class FakeSandboxRepro implements SandboxReproTool {
  constructor(private readonly reproduced: boolean) {}
  reproduce(): { reproduced: boolean } {
    return { reproduced: this.reproduced }
  }
}

/** A fully-wired fake tool bundle with sane null-grounding defaults; override any field per test. */
export function fakeTools(over: Partial<RcaTools> = {}): RcaTools {
  return {
    llm: over.llm ?? new FakeLlmClient(),
    code: over.code ?? new FakeCodeSearch(),
    git: over.git ?? new FakeGitBlameLog(),
    trace: over.trace ?? new FakeTraceCorrelate({ sampled: 0, matched: 0, localizedToOneSpan: 0 }),
    memory: over.memory ?? new FakeMemoryRetrieve(),
    repro: over.repro,
  }
}
