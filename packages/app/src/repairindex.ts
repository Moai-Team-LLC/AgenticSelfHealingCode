/**
 * The proposal index — the read-model that lets BOTH confirm channels (a GitHub PR merge and a Telegram tap)
 * reconstruct the `confirmRepair` inputs from just an approvalId or a PR number. It holds the confirm-time
 * metadata a webhook otherwise wouldn't have — parentSha, moduleArea, classKey, accountable owner, and the
 * GateResult that cleared the fix — captured at propose time.
 *
 * Two implementations behind one interface: `RepairIndex` (in-memory, fakes/tests) and `PgRepairIndex`
 * (durable). Durability matters: on a crash between propose and merge, an in-memory index loses the record, so
 * the merge webhook can't confirm and the fix would deploy with NO landing (the trust controller could then
 * never fast-demote it). The Pg index survives the restart. Every method is async-compatible so callers await
 * either impl.
 */

import type { GateResult } from '@sho/contracts'
import type { Query } from '@sho/orchestrator'

export interface RepairRecord {
  approvalId: string
  incidentId: string
  classKey: string
  moduleArea: string
  parentSha: string
  fixSha: string
  prNumber: number
  prUrl: string
  accountableOwner: string // = trust_class.owner (D9)
  gateResult: GateResult
  status: 'proposed' | 'confirmed' | 'rejected' | 'needs_regate'
}

export interface RepairIndexStore {
  record(r: Omit<RepairRecord, 'status'>): RepairRecord | Promise<RepairRecord>
  byApprovalId(id: string): (RepairRecord | undefined) | Promise<RepairRecord | undefined>
  byPrNumber(n: number): (RepairRecord | undefined) | Promise<RepairRecord | undefined>
  setStatus(approvalId: string, status: RepairRecord['status']): void | Promise<void>
  list(): RepairRecord[] | Promise<RepairRecord[]>
}

/** In-memory index (the fake). Lost on restart — see PgRepairIndex for the durable one. */
export class RepairIndex implements RepairIndexStore {
  private byApproval = new Map<string, RepairRecord>()
  private byPr = new Map<number, string>()

  record(r: Omit<RepairRecord, 'status'>): RepairRecord {
    const row: RepairRecord = { ...r, status: 'proposed' }
    this.byApproval.set(row.approvalId, row)
    this.byPr.set(row.prNumber, row.approvalId)
    return row
  }
  byApprovalId(id: string): RepairRecord | undefined {
    return this.byApproval.get(id)
  }
  byPrNumber(n: number): RepairRecord | undefined {
    const id = this.byPr.get(n)
    return id ? this.byApproval.get(id) : undefined
  }
  setStatus(approvalId: string, status: RepairRecord['status']): void {
    const r = this.byApproval.get(approvalId)
    if (r) r.status = status
  }
  list(): RepairRecord[] {
    return [...this.byApproval.values()]
  }
}

function hydrate(r: Record<string, unknown>): RepairRecord {
  return {
    approvalId: String(r.approval_id),
    incidentId: String(r.incident_id),
    classKey: String(r.class_key),
    moduleArea: String(r.module_area),
    parentSha: String(r.parent_sha),
    fixSha: String(r.fix_sha),
    prNumber: Number(r.pr_number),
    prUrl: String(r.pr_url),
    accountableOwner: String(r.accountable_owner),
    // jsonb comes back a string from the driver — parse it (same gotcha as PgAutoActionStore.gate_result).
    gateResult: (typeof r.gate_result === 'string' ? JSON.parse(r.gate_result) : r.gate_result) as GateResult,
    status: r.status as RepairRecord['status'],
  }
}

/** Durable index over orch.repair_proposal (migration 0008). Survives restart; idempotent on approval_id. */
export class PgRepairIndex implements RepairIndexStore {
  constructor(private readonly query: Query) {}

  async record(r: Omit<RepairRecord, 'status'>): Promise<RepairRecord> {
    const row: RepairRecord = { ...r, status: 'proposed' }
    await this.query(
      `INSERT INTO orch.repair_proposal
         (approval_id, incident_id, class_key, module_area, parent_sha, fix_sha, pr_number, pr_url, accountable_owner, gate_result, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
       ON CONFLICT (approval_id) DO NOTHING`,
      [row.approvalId, row.incidentId, row.classKey, row.moduleArea, row.parentSha, row.fixSha, row.prNumber, row.prUrl, row.accountableOwner, JSON.stringify(row.gateResult), row.status],
    )
    return row
  }
  async byApprovalId(id: string): Promise<RepairRecord | undefined> {
    const rows = await this.query(`SELECT * FROM orch.repair_proposal WHERE approval_id=$1`, [id])
    return rows[0] ? hydrate(rows[0]) : undefined
  }
  async byPrNumber(n: number): Promise<RepairRecord | undefined> {
    const rows = await this.query(`SELECT * FROM orch.repair_proposal WHERE pr_number=$1 ORDER BY created_at DESC LIMIT 1`, [n])
    return rows[0] ? hydrate(rows[0]) : undefined
  }
  async setStatus(approvalId: string, status: RepairRecord['status']): Promise<void> {
    await this.query(`UPDATE orch.repair_proposal SET status=$2 WHERE approval_id=$1`, [approvalId, status])
  }
  async list(): Promise<RepairRecord[]> {
    return (await this.query(`SELECT * FROM orch.repair_proposal ORDER BY created_at`, [])).map(hydrate)
  }
}
