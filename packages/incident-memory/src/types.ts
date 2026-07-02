/**
 * Internal record shapes + the IncidentMemory port. These are the in-memory projections of the
 * `incident_memory.*` tables (sql.ts); shared shapes (OutcomeLabel, OutcomeEvent, AutoAction,
 * WINDOWS_DAYS) come from @sho/contracts and are never redeclared here.
 */

import type { OutcomeLabel, OutcomeEvent, IncidentCandidate } from '@sho/contracts'
import type { Polarity } from './polarity'

/** A deduped incident row (incident_memory.incidents), carrying the drift-resistant recurrence keys. */
export interface IncidentRecord {
  id: string
  fingerprint: string
  /** rename-proof recurrence key: hash(error_class + msg_shape), no symbols/paths (§6). */
  symptomSignature: string
  /** repo dir at fixed depth; drift-stable key shared with the controller's class_key (§6/§10). */
  moduleArea: string
  /** short text embedded for the vector fallback rung (§3/§6); opaque to this store. */
  signalText: string
  firstSeenMs: number
}

/** A proposed/applied fix + its retrieval-facing outcome label (incident_memory.resolutions). */
export interface ResolutionRecord {
  id: string
  incidentId: string
  classKey: string
  /** soft FK to orch.auto_action.action_id; set IFF auto-applied/human-approved-merged, else undefined. */
  actionId?: string
  /** apply landing time; maturation to 'matured' is measured from here (§5.3). */
  appliedAtMs?: number
  /** MUTABLE — matures over time; the poisoning-defense pivot (§5). */
  outcomeLabel: OutcomeLabel
  /** short text embedded for retrieval (resolution rationale); opaque to this store. */
  rationaleText: string
  /** set when replaced by a re-fix (§4 dedup filters these out). */
  supersededBy?: string
  createdAtMs: number
}

/** A retrieval hit: the resolution, its similarity, and — load-bearing — its labeled polarity (§4). */
export interface RetrievalHit {
  resolution: ResolutionRecord
  incident: IncidentRecord
  similarity: number
  weight: number
  /** exemplar | weak | anti-pattern — the caller renders anti-patterns in a SEPARATE block. */
  polarity: Polarity
}

/** Two separately-limited blocks (§4): positives to imitate, negatives to avoid. Never mixed. */
export interface RetrievalResult {
  exemplars: RetrievalHit[] // confirmed_good, then weak positives
  antiPatterns: RetrievalHit[] // recurred | reverted | wrong_rca — labeled, never neutral
}

/** Injected text→text similarity (default: token overlap). Deterministic; no network. */
export type SimilarityFn = (query: string, candidate: string) => number
/** Injected semantic-near matcher for the last recurrence rung (§6). Returns true if vector-near. */
export type VectorMatchFn = (a: IncidentRecord, b: IncidentCandidate) => boolean

export interface RetrieveOpts {
  kPos?: number // exemplar block limit (default 5)
  kNeg?: number // anti-pattern block limit (default 3)
  similarity?: SimilarityFn // override the default token-overlap ranker
  minSimilarity?: number // ANN cutoff; hits below this are dropped (default 0)
}

/** Which recurrence rung fired — logged so drift is a visible alarm, not a silent miss (§6). */
export type MatchBasis = 'fingerprint' | 'symptom_area' | 'vector' | null
export interface RecurrenceResult {
  recurred: boolean
  priorIncidentId: string | null
  basis: MatchBasis
}

/**
 * The why-trace store + outcome projector. Infrastructure (Postgres) sits behind this port with an
 * in-memory default (InMemoryIncidentMemory) so decision logic is testable NOW.
 */
export interface IncidentMemory {
  recordIncident(rec: IncidentRecord): void
  recordResolution(rec: ResolutionRecord): void
  /** Set the retrieval-facing label. Enforces the polarity contract (only confirmed_good is positive). */
  setOutcomeLabel(resolutionId: string, label: OutcomeLabel): void

  /** Outcome-weighted retrieval (attack #8): ranked by injected similarity, weighted by outcome. */
  retrieveSimilar(query: string, k: number, opts?: RetrieveOpts): RetrievalResult

  /** Project a class's resolutions into the controller's OutcomeEvent stream. Idempotent, keyed on actionId. */
  projectOutcomeEvents(classKey: string, nowMs: number): OutcomeEvent[]

  /** Drift-resistant recurrence: fingerprint OR (symptom_signature+module_area) OR injected vector fn. */
  detectRecurrence(incident: IncidentCandidate, nowMs: number, vectorMatch?: VectorMatchFn): RecurrenceResult

  /** Harm count for a class: caused (recurrence|spawn|revert) over BOTH applied_by variants. */
  harmQuery(classKey: string): number
}
