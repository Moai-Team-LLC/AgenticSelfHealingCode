/**
 * Deterministic deploy-correlation branch (LOOP-A-SPEC §2/§3, attack #5). The correlation state and the
 * signal class are computed HERE from candidate data — never "decided" by the LLM — so the model cannot
 * choose to treat an incident as a clean deploy break to save work. This is the anchoring-bias escape
 * hatch as DATA.
 *
 * The contract `CorrelationState` has three values ('deploy_linked' | 'no_recent_deploy' | 'ambiguous');
 * the spec's fourth case `onset_predates_deploy` folds into 'ambiguous' here — both forbid the deploy
 * anchor and take the WIDEN-SEARCH path, which is the property that matters.
 */

import type { CorrelationState, IncidentCandidate, SignalSource } from '@sho/contracts'

/** Whether a signal is an exception (terminates in code) vs a metric (latency/error-rate/saturation). */
export type SignalClass = 'exception' | 'non_exception'

const EXCEPTION_SOURCES: ReadonlySet<SignalSource> = new Set<SignalSource>(['sentry'])

/**
 * Derive the signal class deterministically. Prefer an explicit `signal_class` on the raw payload when the
 * ingest layer set one; otherwise Sentry-sourced signals are exceptions and metric sources are not. Only
 * `exception` unlocks the G3-alone deploy-grounding path (§4); metric signals additionally require G6.
 */
export function deriveSignalClass(c: IncidentCandidate): SignalClass {
  const raw = c.raw_payload
  if (raw && typeof raw === 'object' && 'signal_class' in raw) {
    const sc = String((raw as Record<string, unknown>).signal_class)
    if (sc === 'exception') return 'exception'
    if (sc === 'latency' || sc === 'error-rate' || sc === 'saturation' || sc === 'business-metric' || sc === 'non_exception') {
      return 'non_exception'
    }
  }
  return EXCEPTION_SOURCES.has(c.source) ? 'exception' : 'non_exception'
}

/** The deploy the branch may anchor on: the single in-window deploy that touches an affected path. */
export interface DeployAnchor {
  deployId: string
  tsMs: number
}

export interface CorrelationDerivation {
  state: CorrelationState
  /** the deploy to anchor on — ONLY set for 'deploy_linked'; null otherwise (attack #5 guard). */
  anchor: DeployAnchor | null
  /** true whenever the state is not deploy_linked → the tool loop must WIDEN, not anchor (§3 step 1). */
  searchWidened: boolean
}

/**
 * Compute correlation state from the candidate, evaluated top-to-bottom, first match wins (§2):
 *   1. no_recent_deploy    — no deploy inside the window.
 *   2. onset_predates      — onset strictly before the last in-window deploy → fold to 'ambiguous'.
 *   3. ambiguous           — onset uncertainty overlaps a deploy ts, OR ≥2 in-window deploys with
 *                            conflicting path-touch (no single clear anchor).
 *   4. deploy_linked       — exactly one in-window deploy touches the affected paths, onset after it.
 *
 * `touchesAffectedPaths(deployId)` is injected: in production it is the git.diff hunk-overlap; the caller
 * passes a resolver so this stays a pure function of candidate + that predicate.
 */
export function deriveCorrelationState(
  c: IncidentCandidate,
  opts: {
    windowMinutes?: number
    onsetUncertaintyS?: number
    touchesAffectedPaths: (deployId: string) => boolean
  },
): CorrelationDerivation {
  const windowMs = (opts.windowMinutes ?? 60) * 60_000
  const uncertaintyMs = (opts.onsetUncertaintyS ?? 0) * 1000
  const onsetMs = Date.parse(c.first_seen)

  // in-window deploys within [onset - window, onset + window], each tagged with path-touch. Ordering of
  // onset vs deploy (predates / after) is decided by the rungs below, not here.
  const inWindow = c.recent_deploys
    .map((d) => ({ deployId: d.deploy_id, tsMs: Date.parse(d.ts) }))
    .filter((d) => Number.isFinite(d.tsMs) && d.tsMs >= onsetMs - windowMs && d.tsMs <= onsetMs + windowMs)
    .map((d) => ({ ...d, touches: opts.touchesAffectedPaths(d.deployId) }))

  // rung 1 — no deploy in window.
  if (inWindow.length === 0) {
    return { state: 'no_recent_deploy', anchor: null, searchWidened: true }
  }

  const lastDeploy = inWindow.reduce((a, b) => (b.tsMs > a.tsMs ? b : a))

  // rung 2 — onset predates the deploy: even the LATEST possible onset (onset + uncertainty) is strictly
  // before the last in-window deploy, so the signal cannot have been caused by it → widen (fold to
  // 'ambiguous', the contract's non-anchoring bucket).
  if (onsetMs + uncertaintyMs < lastDeploy.tsMs) {
    return { state: 'ambiguous', anchor: null, searchWidened: true }
  }

  // rung 3 — ambiguity: onset uncertainty interval overlaps a deploy ts, OR conflicting path-touch.
  const overlapsSomeDeploy = inWindow.some(
    (d) => onsetMs - uncertaintyMs <= d.tsMs && d.tsMs <= onsetMs + uncertaintyMs,
  )
  const touching = inWindow.filter((d) => d.touches)
  const conflicting = inWindow.length >= 2 && touching.length >= 1 && touching.length < inWindow.length
  if (overlapsSomeDeploy || conflicting) {
    return { state: 'ambiguous', anchor: null, searchWidened: true }
  }

  // rung 4 — deploy_linked: exactly one in-window deploy touches the affected paths, onset after it.
  if (touching.length === 1) {
    const anchor = touching[0]!
    if (onsetMs - uncertaintyMs >= anchor.tsMs) {
      return { state: 'deploy_linked', anchor: { deployId: anchor.deployId, tsMs: anchor.tsMs }, searchWidened: false }
    }
  }

  // a deploy is in-window but nothing touches the path (or onset not clearly after): do not anchor.
  return { state: 'ambiguous', anchor: null, searchWidened: true }
}
