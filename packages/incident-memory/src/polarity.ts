/**
 * Outcome-weighted retrieval polarity (INCIDENT-MEMORY.md §4/§5, attack #8). Retrieval MUST NOT treat
 * all similar past resolutions as neutral. Polarity is driven ENTIRELY by `resolutions.outcome_label`
 * (the ledger), never by "was it green". Only `confirmed_good` is a full positive exemplar;
 * `recurred | reverted | wrong_rca` are anti-patterns surfaced AS SUCH; `applied` /
 * `provisional_human_confirmed` are weak; nothing failed is ever returned as a neutral match.
 */

import type { OutcomeLabel } from '@sho/contracts'

/** How a retrieved resolution is presented to the caller — the anti-#8 taxonomy. */
export type Polarity = 'exemplar' | 'weak' | 'anti-pattern' | 'neutral'

/** Retrieval weight per label (§5.6). confirmed_good=1; anti-patterns=-1; weak/provisional between. */
export const POLARITY_WEIGHT: Record<OutcomeLabel, number> = {
  confirmed_good: 1.0,
  applied: 0.55, // unconfirmed: weak, provisional
  provisional_human_confirmed: 0.5, // weak human confirmation, never a full exemplar
  proposed: 0.35, // never applied: weakest positive
  recurred: -1.0, // anti-pattern
  reverted: -1.0, // anti-pattern
  wrong_rca: -1.0, // anti-pattern (Loop A)
  superseded: 0.0, // replaced by a re-fix; filtered out of retrieval
}

/** The three anti-pattern terminal labels — sticky, win their block, never a positive exemplar. */
export const ANTI_PATTERN_LABELS: ReadonlySet<OutcomeLabel> = new Set<OutcomeLabel>(['recurred', 'reverted', 'wrong_rca'])

/** Only this label is a full positive exemplar (§4). */
export const POSITIVE_EXEMPLAR_LABEL: OutcomeLabel = 'confirmed_good'

/** Weak-but-positive labels: offered as provisional precedent, cannot dominate a confirmed-good one. */
export const WEAK_LABELS: ReadonlySet<OutcomeLabel> = new Set<OutcomeLabel>(['applied', 'provisional_human_confirmed', 'proposed'])

/**
 * Classify a resolution's label into its retrieval polarity. This is the single point that keeps
 * a wrong-but-green fix from ever presenting as something to imitate.
 */
export function polarityOf(label: OutcomeLabel): Polarity {
  if (label === POSITIVE_EXEMPLAR_LABEL) return 'exemplar'
  if (ANTI_PATTERN_LABELS.has(label)) return 'anti-pattern'
  if (WEAK_LABELS.has(label)) return 'weak'
  return 'neutral' // 'superseded' / any future label — filtered by the caller, never copied
}
