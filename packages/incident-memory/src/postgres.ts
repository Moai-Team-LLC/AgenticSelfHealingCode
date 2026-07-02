/**
 * PostgresIncidentMemory — thin adapter over an injected `query(sql, params) => rows` executor. Real pg
 * wiring (pool, pgvector) is out of scope: this class only translates the port's operations into the
 * shared `incident_memory.*` schema and delegates. The DECISION rules (drift-resistant rung order §6,
 * outcome-weighted polarity §4, W_mature deferral §5.3) are reused from the in-memory impl / pure
 * helpers so the two implementations cannot diverge.
 *
 * Because this environment has no Postgres, the reads that need row hydration return via the executor;
 * the recurrence/retrieval/projection SHAPES are asserted by the in-memory tests, and this adapter is
 * kept deliberately mechanical so a live pg executor is the only missing piece.
 */

import type { OutcomeEvent, OutcomeLabel, IncidentCandidate } from '@sho/contracts'
import { WINDOWS_DAYS } from '@sho/contracts'
import { ANTI_PATTERN_LABELS } from './polarity'
import { moduleAreaOf, symptomSignatureOf } from './memory'
import type {
  IncidentRecord,
  ResolutionRecord,
  RetrievalResult,
  RetrieveOpts,
  RecurrenceResult,
} from './types'

/** Injected executor — rows come back as plain objects; this is the ONLY seam to real Postgres. */
export type Query = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>

const DAY = 86_400_000

/**
 * Async sibling of {@link InMemoryIncidentMemory}: identical method names and rules, but every read is a
 * Promise (it awaits the injected `query`). It intentionally does NOT `implements IncidentMemory` — that
 * port is the synchronous in-memory contract the tests pin; this adapter mirrors it for the pg backend.
 */
export class PostgresIncidentMemory {
  constructor(private readonly query: Query) {}

  // Writes are AWAITABLE (Promise<void>): callers that must observe the row before a follow-up read
  // (e.g. the app's notify_state CAS after recordIncident) await them. The in-memory sibling stays sync.
  async recordIncident(rec: IncidentRecord): Promise<void> {
    await this.query(
      `INSERT INTO incident_memory.incidents (id, fingerprint, symptom_signature, module_area, first_seen)
       VALUES ($1,$2,$3,$4,to_timestamp($5/1000.0))
       ON CONFLICT (id) DO NOTHING`,
      [rec.id, rec.fingerprint, rec.symptomSignature, rec.moduleArea, rec.firstSeenMs],
    )
  }

  async recordResolution(rec: ResolutionRecord): Promise<void> {
    await this.query(
      `INSERT INTO incident_memory.resolutions (id, incident_id, auto_action_id, ck_outcome_label, created_at)
       VALUES ($1,$2,$3,$4,to_timestamp($5/1000.0))
       ON CONFLICT (id) DO NOTHING`,
      [rec.id, rec.incidentId, rec.actionId ?? null, rec.outcomeLabel, rec.createdAtMs],
    )
  }

  async setOutcomeLabel(resolutionId: string, label: OutcomeLabel): Promise<void> {
    // The confirmed_good⇒landed-action invariant (§5.2) is enforced by the writer; the DB CHECK
    // constraint (sql.ts ck_outcome_label) is the storage-layer backstop.
    await this.query(
      `UPDATE incident_memory.resolutions
         SET ck_outcome_label = $2, matured_at = CASE WHEN $2 = 'confirmed_good' THEN now() ELSE matured_at END
       WHERE id = $1`,
      [resolutionId, label],
    )
  }

  /**
   * Outcome-weighted retrieval (§4). Ranking is pgvector cosine on the `signal` embedding; the two
   * blocks are split by label polarity. Rows come back tagged with `block` ('exemplar'|'anti') so the
   * adapter routes each into the right array with its weight — the same polarity split the in-memory
   * impl performs, done in SQL. Hydration is mechanical; the query itself is INCIDENT-MEMORY.md §4.
   */
  async retrieveSimilar(embeddingRef: string, k: number, opts: RetrieveOpts = {}): Promise<RetrievalResult> {
    const rows = await this.query(
      `-- INCIDENT-MEMORY.md §4 outcome-weighted retrieval (pgvector); returns block-tagged, per-block limited rows
       SELECT resolution_id, incident_id, label, block, similarity, weight
         FROM incident_memory.retrieve_outcome_weighted($1, $2, $3)`,
      [embeddingRef, opts.kPos ?? k ?? 5, opts.kNeg ?? 3],
    )
    const exemplars: RetrievalResult['exemplars'] = []
    const antiPatterns: RetrievalResult['antiPatterns'] = []
    for (const row of rows) {
      const hit = {
        resolution: { id: String(row.resolution_id), incidentId: String(row.incident_id), outcomeLabel: row.label as OutcomeLabel } as ResolutionRecord,
        incident: { id: String(row.incident_id) } as IncidentRecord,
        similarity: Number(row.similarity),
        weight: Number(row.weight),
        polarity: row.block === 'anti' ? ('anti-pattern' as const) : row.weight >= 1 ? ('exemplar' as const) : ('weak' as const),
      }
      if (hit.polarity === 'anti-pattern') antiPatterns.push(hit)
      else exemplars.push(hit)
    }
    return { exemplars, antiPatterns }
  }

  /** Idempotent projection (§7): same rules as the in-memory impl, expressed over the resolutions table. */
  async projectOutcomeEvents(classKey: string, nowMs: number): Promise<OutcomeEvent[]> {
    const rows = await this.query(
      `SELECT r.auto_action_id AS action_id, r.ck_outcome_label AS label,
              extract(epoch FROM a.applied_at)*1000 AS applied_ms
         FROM incident_memory.resolutions r
         JOIN orch.auto_action a ON a.action_id = r.auto_action_id
        WHERE a.class_key = $1 AND r.auto_action_id IS NOT NULL`,
      [classKey],
    )
    const events: OutcomeEvent[] = []
    const seenApplied = new Set<string>()
    for (const row of rows) {
      const actionId = String(row.action_id)
      const appliedMs = Number(row.applied_ms)
      if (!seenApplied.has(actionId)) {
        seenApplied.add(actionId)
        events.push({ actionId, kind: 'applied', at: new Date(appliedMs).toISOString() })
      }
      const label = row.label as OutcomeLabel
      if (label === 'confirmed_good') {
        if (Number.isFinite(appliedMs) && nowMs - appliedMs >= WINDOWS_DAYS.W_mature * DAY) {
          events.push({ actionId, kind: 'matured', at: new Date(appliedMs + WINDOWS_DAYS.W_mature * DAY).toISOString() })
        }
      } else if (label === 'recurred') {
        events.push({ actionId, kind: 'recurrence', at: new Date(nowMs).toISOString() })
      } else if (label === 'reverted') {
        events.push({ actionId, kind: 'revert', at: new Date(nowMs).toISOString() })
      }
    }
    return events
  }

  /** Drift-resistant recurrence (§6): fingerprint → symptom_area → vector, in one query with the rungs ORed. */
  async detectRecurrence(incident: IncidentCandidate, nowMs: number): Promise<RecurrenceResult> {
    const rows = await this.query(
      `SELECT id,
              (fingerprint = $1) AS fp_match,
              (symptom_signature = $2 AND module_area = $3) AS area_match
         FROM incident_memory.incidents
        WHERE fingerprint = $1
           OR (symptom_signature = $2 AND module_area = $3)
        ORDER BY (fingerprint = $1) DESC
        LIMIT 1`,
      [incident.fingerprint, symptomSignatureOf(incident), moduleAreaOf(incident)],
    )
    const hit = rows[0]
    if (hit) {
      return { recurred: true, priorIncidentId: String(hit.id), basis: hit.fp_match ? 'fingerprint' : 'symptom_area' }
    }
    // vector rung is the executor's ANN fallback (pgvector); no structured hit ⇒ defer to it upstream.
    void nowMs
    return { recurred: false, priorIncidentId: null, basis: null }
  }

  /** Harm count (§7.3): distinct actions with a caused label — over BOTH applied_by variants (§2.2). */
  async harmQuery(classKey: string): Promise<number> {
    const labels = [...ANTI_PATTERN_LABELS].filter((l): l is 'recurred' | 'reverted' => l === 'recurred' || l === 'reverted')
    // labels are trusted compile-time constants (not user input) → inline as an IN-list. This is
    // driver-portable; `= ANY($n)` array binding is serialized differently across pg clients (Bun/node-pg/postgres.js).
    const inList = labels.map((l) => `'${l}'`).join(', ')
    const rows = await this.query(
      `SELECT count(DISTINCT r.auto_action_id) AS harmed
         FROM incident_memory.resolutions r
         JOIN orch.auto_action a ON a.action_id = r.auto_action_id
        WHERE a.class_key = $1
          AND r.ck_outcome_label IN (${inList})
          AND r.auto_action_id IS NOT NULL`,
      [classKey],
    )
    return Number(rows[0]?.harmed ?? 0)
  }
}
