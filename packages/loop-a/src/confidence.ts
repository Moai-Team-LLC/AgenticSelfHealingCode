/**
 * Grounded confidence (LOOP-A-SPEC §4, D3/D8). Confidence is a set of OBSERVABLE booleans, each set by a
 * mechanical check or a tool result — NEVER by an LLM number (self-reported LLM confidence is
 * ~uncorrelated with correctness, STRESS-TEST §2). The gate is a pure function of the booleans, an AND of
 * grounding so nothing compounds silently (the 0.9³ argument, §4).
 *
 * The four contract booleans (`GroundedConfidence` from @sho/contracts) are the persisted surface:
 *   reproduced (G1) · explainsAllOccurrences (G2) · affectedPathInDeployDiff (G3) · stepVsSlopeConsistent (G6)
 * Two further §4 booleans — G7 (deploy-independent trace localization) and the STRUCTURAL floors G4/G5 —
 * are not in the contract shape; they are computed here and fed to the gate alongside the four.
 */

import type { GroundedConfidence } from '@sho/contracts'
import type { CorrelationState } from '@sho/contracts'
import type { SignalClass } from './correlation'

/** Config knobs (VERIFICATION-GATE.md owns the shared defaults; §4 config block). */
export interface GateConfig {
  g2SampleSize: number // trace_ids sampled for occurrence-match
  g2MatchThreshold: number // matched fraction to set G2 = true
  g7LocalizationThreshold: number // fraction pinning to one span to set G7 = true
}

export const DEFAULT_GATE_CONFIG: GateConfig = {
  g2SampleSize: 50,
  g2MatchThreshold: 0.95,
  g7LocalizationThreshold: 0.9,
}

/** Raw tool observations the booleans are DERIVED from. Everything here is a tool result, not a claim. */
export interface ToolObservations {
  /** repro.sandbox result; undefined when no harness ran → G1 stays null (only `true` counts). */
  reproduced?: boolean
  /** trace.correlate occurrence match: sampled, matched, localized-to-one-span. */
  occurrence: { sampled: number; matched: number; localizedToOneSpan: number } | null
  /** git.diff hunk-overlap: is the hypothesis's cited path present in the correlated deploy diff? */
  pathInDeployDiff: boolean | null
  /** §2 `shape`-derived step-vs-slope: onset is a step coincident with the deploy ts. */
  stepChangeAtDeploy: boolean | null
}

/** The full §4 boolean set: the four contract booleans + G7 + the two structural floors. */
export interface FullConfidence {
  contract: GroundedConfidence // G1/G2/G3/G6 — persisted on the WhyTrace
  occurrencesLocalizedToOneSpan: boolean | null // G7 (deploy-independent grounding path)
  everyClaimCited: boolean // G4 — structural floor (citations resolve)
  alternativesRefuted: boolean // G5 — structural floor (alternatives closed or explicitly open)
}

/**
 * Compute the grounded booleans MECHANICALLY from tool observations (§4). Note the strict null discipline:
 * a check that was not run, or is not applicable, is `null` — NEVER silently `true`. G3 is `null` (never
 * borrowable) for non-deploy-linked incidents; G6 is `null` for exception signals.
 */
export function computeConfidence(
  obs: ToolObservations,
  ctx: {
    signalClass: SignalClass
    correlationState: CorrelationState
    everyClaimCited: boolean
    alternativesRefuted: boolean
    config?: GateConfig
  },
): FullConfidence {
  const cfg = ctx.config ?? DEFAULT_GATE_CONFIG

  // G1 — reproduction. Only `true` grounds; a missing harness leaves it null (not false).
  const reproduced: boolean | null = obs.reproduced === undefined ? null : obs.reproduced

  // G2 — mechanical occurrence-match fraction. If no mechanical match ran → null, NOT true.
  const explainsAllOccurrences: boolean | null =
    obs.occurrence && obs.occurrence.sampled > 0
      ? obs.occurrence.matched / obs.occurrence.sampled >= cfg.g2MatchThreshold
      : null

  // G3 — path-in-deploy-diff. Meaningful ONLY when deploy_linked; null (not passing) otherwise (attack #5).
  const affectedPathInDeployDiff: boolean | null =
    ctx.correlationState === 'deploy_linked' ? obs.pathInDeployDiff ?? null : null

  // G6 — step-vs-slope. Applies ONLY to non-exception signals; null (n/a) for exceptions.
  const stepVsSlopeConsistent: boolean | null =
    ctx.signalClass === 'exception' ? null : obs.stepChangeAtDeploy ?? null

  // G7 — deploy-independent localization to a single span. The grounding path for silent-degradation /
  // no-sandbox incidents so they are not permanently floored at ESCALATE.
  const occurrencesLocalizedToOneSpan: boolean | null =
    obs.occurrence && obs.occurrence.sampled > 0
      ? obs.occurrence.localizedToOneSpan / obs.occurrence.sampled >= cfg.g7LocalizationThreshold
      : null

  return {
    contract: { reproduced, explainsAllOccurrences, affectedPathInDeployDiff, stepVsSlopeConsistent },
    occurrencesLocalizedToOneSpan,
    everyClaimCited: ctx.everyClaimCited,
    alternativesRefuted: ctx.alternativesRefuted,
  }
}

export type Gate = 'CONFIRMED' | 'ESCALATE'

/**
 * The gate (§4) — a PURE function of the booleans + signal class + correlation state. No LLM. This is the
 * AND that stops 0.9³: every GROUNDED disjunct is ANDed with G2 and the STRUCTURAL floor, so no single
 * lucky factor can carry it.
 */
export function gate(c: FullConfidence, signalClass: SignalClass, correlationState: CorrelationState): Gate {
  const g = c.contract
  const structural = c.everyClaimCited === true && c.alternativesRefuted === true

  const grounded =
    g.reproduced === true || // G1 — reproduced (any signal class), OR
    (signalClass === 'exception' && correlationState === 'deploy_linked' && g.affectedPathInDeployDiff === true) || // exception + path in causal diff, OR
    (signalClass !== 'exception' &&
      correlationState === 'deploy_linked' &&
      g.affectedPathInDeployDiff === true &&
      g.stepVsSlopeConsistent === true) || // non-exception: path in diff AND step-at-deploy, OR
    c.occurrencesLocalizedToOneSpan === true // G7 — deploy-independent localization

  const confirmed = structural && g.explainsAllOccurrences === true && grounded
  return confirmed ? 'CONFIRMED' : 'ESCALATE'
}

/**
 * A scoreable "grounded strength" over the booleans (§4, the escalate-vs-guess dial). This does NOT
 * replace the gate — the gate is authoritative — but it explains, for the human, HOW FAR a below-threshold
 * trace is from CONFIRMED and drives which missing boolean to name. Range [0,1]; only `true` counts.
 */
export function groundedStrength(c: FullConfidence): number {
  const g = c.contract
  const factors: (boolean | null)[] = [
    g.reproduced,
    g.explainsAllOccurrences,
    g.affectedPathInDeployDiff,
    g.stepVsSlopeConsistent,
    c.occurrencesLocalizedToOneSpan,
    c.everyClaimCited,
    c.alternativesRefuted,
  ]
  const present = factors.filter((f) => f !== null)
  if (present.length === 0) return 0
  const passed = present.filter((f) => f === true).length
  return passed / present.length
}

/** Name the specific missing boolean(s) that block CONFIRMED (§5 ESCALATE detail). Human-facing text. */
export function missingBooleans(c: FullConfidence, signalClass: SignalClass, correlationState: CorrelationState): string[] {
  const g = c.contract
  const missing: string[] = []
  if (c.everyClaimCited !== true) missing.push('G4: a claim lacks a resolving citation')
  if (c.alternativesRefuted !== true) missing.push('G5: a live alternative is still open')
  if (g.explainsAllOccurrences !== true) missing.push('G2: hypothesis does not mechanically explain enough occurrences')

  const groundingHeld =
    g.reproduced === true ||
    (signalClass === 'exception' && correlationState === 'deploy_linked' && g.affectedPathInDeployDiff === true) ||
    (signalClass !== 'exception' &&
      correlationState === 'deploy_linked' &&
      g.affectedPathInDeployDiff === true &&
      g.stepVsSlopeConsistent === true) ||
    c.occurrencesLocalizedToOneSpan === true
  if (!groundingHeld) {
    if (g.reproduced === null) missing.push('G1: no sandbox harness for this service (reproduced=null)')
    if (correlationState === 'deploy_linked' && g.affectedPathInDeployDiff !== true)
      missing.push('G3: deploy-linked but implicated path not in the diff')
    if (signalClass !== 'exception' && g.stepVsSlopeConsistent === false)
      missing.push('G6: slope onset inconsistent with a single-deploy step change')
    if (c.occurrencesLocalizedToOneSpan !== true) missing.push('G7: occurrences not localized to one span')
  }
  return missing
}
