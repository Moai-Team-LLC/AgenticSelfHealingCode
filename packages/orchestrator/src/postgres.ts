/**
 * Durable (Postgres-backed) siblings of the in-memory orchestrator stores (ORCHESTRATION.md, D1/§11).
 * The whole point of the durable orchestrator is that state SURVIVES process restarts: kill bit,
 * notify_state, and the auto_action ledger all live in Postgres, so a fresh process reads exactly where
 * the last one left off. These mirror the in-memory classes method-for-method but every op is async
 * (awaits the injected `query`). The in-memory versions remain the fakes for unit tests.
 */

import type { AutoAction } from '@sho/contracts'
import type { LandingInput } from './autoaction'

/** Injected executor — the only seam to real Postgres. */
export type Query = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>

// ── durable auto_action ledger (orch.auto_action) ──────────────────────────

function hydrate(r: Record<string, unknown>): AutoAction {
  return {
    action_id: String(r.action_id), incident_id: String(r.incident_id), class_key: String(r.class_key),
    loop: r.loop as 'B' | 'C', applied_by: r.applied_by as 'machine' | 'human_approved',
    applied_at: new Date(r.applied_at as string).toISOString(), fix_sha: String(r.fix_sha), parent_sha: String(r.parent_sha),
    // jsonb comes back as a STRING from the driver (Bun SQL) — parse it so the frozen GateResult round-trips
    // as an object (a raw cast would leave `.pass` undefined for every reader of the durable landing).
    gate_result: (typeof r.gate_result === 'string' ? JSON.parse(r.gate_result) : r.gate_result) as AutoAction['gate_result'],
    accountable_owner: String(r.accountable_owner), module_area: String(r.module_area),
  }
}

export class PgAutoActionStore {
  constructor(private readonly query: Query) {}

  async insert(row: AutoAction): Promise<void> {
    await this.query(
      `INSERT INTO orch.auto_action (action_id, incident_id, class_key, loop, applied_by, applied_at, fix_sha, parent_sha, gate_result, accountable_owner, module_area)
       VALUES ($1,$2,$3,$4,$5,to_timestamp($6/1000.0),$7,$8,$9::jsonb,$10,$11)
       ON CONFLICT (incident_id, fix_sha) DO NOTHING`,
      [row.action_id, row.incident_id, row.class_key, row.loop, row.applied_by, Date.parse(row.applied_at), row.fix_sha, row.parent_sha, JSON.stringify(row.gate_result), row.accountable_owner, row.module_area],
    )
  }
  async getByIncidentFix(incidentId: string, fixSha: string): Promise<AutoAction | undefined> {
    const rows = await this.query(`SELECT * FROM orch.auto_action WHERE incident_id=$1 AND fix_sha=$2`, [incidentId, fixSha])
    return rows[0] ? hydrate(rows[0]) : undefined
  }
  async listByClass(classKey: string): Promise<AutoAction[]> {
    return (await this.query(`SELECT * FROM orch.auto_action WHERE class_key=$1 ORDER BY applied_at`, [classKey])).map(hydrate)
  }
  async listByArea(moduleArea: string): Promise<AutoAction[]> {
    return (await this.query(`SELECT * FROM orch.auto_action WHERE module_area=$1 ORDER BY applied_at`, [moduleArea])).map(hydrate)
  }
  async get(actionId: string): Promise<AutoAction | undefined> {
    const rows = await this.query(`SELECT * FROM orch.auto_action WHERE action_id=$1`, [actionId])
    return rows[0] ? hydrate(rows[0]) : undefined
  }
}

/**
 * Durable apply-time writer (ORCHESTRATION §5, coherence BLOCKER #3/#5). Idempotent on
 * (incident_id, fix_sha): the DB UNIQUE + ON CONFLICT makes redelivery a no-op even under a race —
 * whoever's row is canonical is `created`, and only that caller links the resolution.
 */
export async function applyTimeWriteAsync(
  store: PgAutoActionStore,
  input: LandingInput,
  linkResolution?: (actionId: string) => void | Promise<void>,
): Promise<{ action: AutoAction; created: boolean }> {
  const existing = await store.getByIncidentFix(input.incident_id, input.fix_sha)
  if (existing) return { action: existing, created: false }
  const action: AutoAction = {
    action_id: crypto.randomUUID(), incident_id: input.incident_id, class_key: input.class_key, loop: input.loop,
    applied_by: input.applied_by, applied_at: input.applied_at ?? new Date().toISOString(), fix_sha: input.fix_sha,
    parent_sha: input.parent_sha, gate_result: input.gate_result, accountable_owner: input.accountable_owner, module_area: input.module_area,
  }
  await store.insert(action) // ON CONFLICT DO NOTHING
  const canonical = await store.getByIncidentFix(input.incident_id, input.fix_sha)
  const created = canonical?.action_id === action.action_id // false if a concurrent insert won the row
  if (created) await linkResolution?.(action.action_id)
  return { action: canonical ?? action, created }
}

// ── durable notify_state CAS (incident_memory.incidents.notify_state) ──────

export class PgNotifyStore {
  constructor(private readonly query: Query) {}
  /** Atomic durable CAS: investigating→notified. True iff THIS call performed the transition. */
  async casNotified(incidentId: string): Promise<boolean> {
    const rows = await this.query(
      `UPDATE incident_memory.incidents SET notify_state='notified' WHERE id=$1 AND notify_state='investigating' RETURNING id`,
      [incidentId],
    )
    return rows.length > 0
  }
  async get(incidentId: string): Promise<'investigating' | 'notified' | undefined> {
    const rows = await this.query(`SELECT notify_state FROM incident_memory.incidents WHERE id=$1`, [incidentId])
    return rows[0] ? (rows[0].notify_state as 'investigating' | 'notified') : undefined
  }
}

// ── durable kill bit (orch.kill_switch) ────────────────────────────────────

export class PgKillSwitch {
  constructor(private readonly query: Query, private readonly heartbeatTtlMs = 30_000, private readonly releaseSecret?: string) {}

  async heartbeat(nowMs: number): Promise<void> {
    await this.query(`UPDATE orch.kill_switch SET heartbeat_at=to_timestamp($1/1000.0) WHERE id`, [nowMs])
  }
  async engage(): Promise<void> {
    await this.query(`UPDATE orch.kill_switch SET engaged=true WHERE id`, [])
  }
  /** Release requires the signed token (HITL-APPROVAL §6). Returns the effective killed state after. */
  async release(token: string, nowMs: number): Promise<boolean> {
    if (this.releaseSecret && token === this.releaseSecret) await this.query(`UPDATE orch.kill_switch SET engaged=false WHERE id`, [])
    return this.isKilled(nowMs)
  }
  /** KILLED iff explicitly engaged OR heartbeat is stale (fail-safe). Absence of the row ⇒ killed. */
  async isKilled(nowMs: number): Promise<boolean> {
    const rows = await this.query(`SELECT engaged, extract(epoch FROM heartbeat_at)*1000 AS hb FROM orch.kill_switch WHERE id`, [])
    const r = rows[0]
    if (!r) return true
    return r.engaged === true || nowMs - Number(r.hb) > this.heartbeatTtlMs
  }
}
