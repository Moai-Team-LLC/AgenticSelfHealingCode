/**
 * The RCA copilot entry point (LOOP-A-SPEC §3, Interfaces). Tier 1: ZERO write access — it only reads via
 * the injected read-only tools, runs the fixed tool-loop skeleton, computes grounded confidence
 * MECHANICALLY, applies the pure gate, and assembles a WhyTrace (contracts type). It never opens a PR,
 * never applies anything. Below the gate it ESCALATES with findings — it does NOT fabricate a fix.
 *
 * `investigate` is deterministic given its tools and `nowMs`: no wall-clock reads, no randomness in the
 * decision path (the only nondeterminism is the injected LLM's narration, which is never the confidence
 * source).
 */

import type { IncidentCandidate, WhyTrace } from '@sho/contracts'
import { looksLikeInjection } from '@sho/contracts'
import { deriveCorrelationState, deriveSignalClass, type SignalClass } from './correlation'
import {
  computeConfidence,
  gate,
  groundedStrength,
  missingBooleans,
  DEFAULT_GATE_CONFIG,
  type FullConfidence,
  type Gate,
  type GateConfig,
} from './confidence'
import type { RcaTools } from './tools'

export interface InvestigateOptions {
  windowMinutes?: number
  onsetUncertaintyS?: number
  config?: GateConfig
  /** untrusted telemetry text observed during the loop (log lines/messages) — scanned for injection (D7). */
  telemetryText?: string[]
}

/** The full investigation result: the persisted WhyTrace + the internal booleans/score for callers. */
export interface Investigation {
  trace: WhyTrace
  gate: Gate
  confidence: FullConfidence
  signalClass: SignalClass
  groundedStrength: number
  searchWidened: boolean
  /** on ESCALATE, the specific missing booleans (§5 detail). Empty on CONFIRMED. */
  missing: string[]
}

/**
 * Run the fixed tool-loop (§3): ingest → branch on deterministic correlation_state → retrieve memory →
 * form hypothesis (LLM proposes, we do NOT take its confidence) → gather MECHANICAL grounding → gate.
 */
export function investigate(candidate: IncidentCandidate, tools: RcaTools, opts: InvestigateOptions = {}): Investigation {
  const cfg = opts.config ?? DEFAULT_GATE_CONFIG
  const signalClass = deriveSignalClass(candidate)

  // ── step 1: BRANCH on deterministic correlation_state. `touches` uses the read-only git.diff. ──
  // Pre-compute the deploy diff once so the anchor predicate and the later G3 check agree exactly.
  const diffByDeploy = new Map<string, { path: string; hunk: string }[]>()
  const touchesAffectedPaths = (deployId: string): boolean => {
    const deploy = candidate.recent_deploys.find((d) => d.deploy_id === deployId)
    if (!deploy) return false
    let hunks = diffByDeploy.get(deployId)
    if (!hunks) {
      // shaRange is opaque to us; the adapter maps deploy → sha-range. Fake returns the touched paths.
      hunks = tools.git.diff({ shaRange: deploy.diff_url ?? deployId })
      diffByDeploy.set(deployId, hunks)
    }
    return hunks.some((h) => candidate.affected_paths.includes(h.path))
  }
  const corr = deriveCorrelationState(candidate, {
    windowMinutes: opts.windowMinutes,
    onsetUncertaintyS: opts.onsetUncertaintyS,
    touchesAffectedPaths,
  })

  // ── step 2: RETRIEVE similar past incidents (outcome-weighted §6). Read-only. ──
  const query = `${candidate.affected_service} ${candidate.affected_paths.join(' ')} ${candidate.fingerprint}`
  const retrieved = tools.memory.retrieve({ query })
  const similarIncidents: WhyTrace['similarIncidents'] = [
    ...retrieved.exemplars.map((e) => ({ id: e.incidentId, outcome: coerceOutcome(e.outcomeLabel), resolutionRef: e.resolutionRef })),
    ...retrieved.antiPatterns.map((a) => ({ id: a.incidentId, outcome: coerceOutcome(a.outcomeLabel), resolutionRef: a.resolutionRef })),
  ]

  // ── step 3: FORM hypotheses (LLM proposes; its confidence is IGNORED by design). ──
  const evidenceSummary = `state=${corr.state} class=${signalClass} occ=${candidate.occurrences} deploys=${candidate.recent_deploys.length}`
  const proposal = tools.llm.propose({ candidate, evidenceSummary })

  // ── step 4: GATHER mechanical grounding evidence for the top hypothesis. ──
  // G1 — hypothesis-free repro at HEAD (§3 step 0), only if a harness exists.
  const reproduced = tools.repro
    ? tools.repro.reproduce({ sha: 'HEAD', replay: { kind: 'captured_request', ref: candidate.fingerprint } }).reproduced
    : undefined

  // G2 / G7 — mechanical occurrence match over a sample.
  const occurrence = tools.trace.correlate({
    fingerprint: candidate.fingerprint,
    matchSignature: proposal.primary.citedPath,
    sample: cfg.g2SampleSize,
  })

  // G3 — is the hypothesis's cited path actually in the ANCHORED deploy diff? Only if deploy_linked. The
  // diff was already fetched+cached by the correlation predicate, so G3 and the anchor decision agree.
  const citedPath = proposal.primary.citedPath
  const anchorDiff = corr.anchor ? (diffByDeploy.get(corr.anchor.deployId) ?? []) : []
  const pathInDeployDiff: boolean | null =
    corr.state === 'deploy_linked'
      ? citedPath !== undefined && anchorDiff.some((h) => h.path === citedPath)
      : null

  // G6 — step-vs-slope from §2 `shape`, non-exception only. A `step` coincident with the deploy is
  // consistent; a `slope` is mechanically inconsistent with a single-deploy break.
  const stepChangeAtDeploy: boolean | null =
    signalClass === 'exception' ? null : corr.state === 'deploy_linked' ? candidate.shape === 'step' : false

  // ── structural floors G4/G5, verified by the emit path, computed here mechanically. ──
  const everyClaimCited = proposal.primary.statement.trim().length > 0 && (citedPath !== undefined || occurrence.matched > 0)
  const alternativesRefuted = proposal.alternatives.length > 0 // each enumerated alternative is recorded

  const confidence = computeConfidence(
    { reproduced, occurrence, pathInDeployDiff, stepChangeAtDeploy },
    { signalClass, correlationState: corr.state, everyClaimCited, alternativesRefuted, config: cfg },
  )

  // ── step 5: GATE (pure function, no LLM). ──
  const decision = gate(confidence, signalClass, corr.state)
  const strength = groundedStrength(confidence)
  const missing = decision === 'CONFIRMED' ? [] : missingBooleans(confidence, signalClass, corr.state)

  // D7 — scan any untrusted telemetry text for instruction-like content; surface, never act on it.
  const suspiciousContentFlag = (opts.telemetryText ?? []).some((t) => looksLikeInjection(t))

  // ── assemble the WhyTrace (contracts shape). On ESCALATE we STILL hand over ranked hypotheses + the
  //    named missing evidence; we never fabricate a fix to clear the gate. ──
  const recommendedAction =
    decision === 'CONFIRMED'
      ? recommendedFor(proposal.primary.fixClass, corr.state, candidate)
      : `ESCALATE to on-call: ${proposal.primary.statement}. Missing grounding — ${missing.join('; ') || 'insufficient grounded evidence'}. Human decides.`

  const trace: WhyTrace = {
    incidentId: candidate.id,
    hypothesis: proposal.primary.statement,
    alternatives: proposal.alternatives,
    confidence: confidence.contract,
    correlationState: corr.state,
    affectedComponents: candidate.affected_paths.length > 0 ? candidate.affected_paths : [candidate.affected_service],
    fixClass: proposal.primary.fixClass,
    recommendedAction,
    suspiciousContentFlag,
    similarIncidents,
  }

  return {
    trace,
    gate: decision,
    confidence,
    signalClass,
    groundedStrength: strength,
    searchWidened: corr.searchWidened,
    missing,
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** The recommended human ACTION (Loop A only advises; on-call is the actor). */
function recommendedFor(
  fixClass: WhyTrace['fixClass'],
  state: WhyTrace['correlationState'],
  candidate: IncidentCandidate,
): string {
  if (state === 'deploy_linked' && candidate.recent_deploys.length > 0) {
    const d = candidate.recent_deploys[candidate.recent_deploys.length - 1]!
    return `Recommend on-call roll back deploy ${d.deploy_id} (fastest mitigation); durable ${fixClass} fix by a human.`
  }
  return `Recommend on-call apply a ${fixClass} fix on ${candidate.affected_paths[0] ?? candidate.affected_service}; Loop A only advises.`
}

/** Coerce a retrieved outcome-label string into the contract OutcomeLabel; unknown → 'proposed' (weakest). */
function coerceOutcome(label: string): WhyTrace['similarIncidents'][number]['outcome'] {
  const known = new Set([
    'proposed',
    'applied',
    'provisional_human_confirmed',
    'confirmed_good',
    'recurred',
    'reverted',
    'wrong_rca',
    'superseded',
  ])
  return (known.has(label) ? label : 'proposed') as WhyTrace['similarIncidents'][number]['outcome']
}
