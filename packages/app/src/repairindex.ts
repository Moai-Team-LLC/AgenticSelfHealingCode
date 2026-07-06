/**
 * The proposal index — the small read-model that lets BOTH confirm channels (a GitHub PR merge and a
 * Telegram tap) reconstruct the `confirmRepair` inputs from just an approvalId or a PR number. It holds the
 * confirm-time metadata a webhook otherwise wouldn't have — parentSha, moduleArea, classKey, accountable
 * owner, and the GateResult that cleared the fix — captured at propose time. In-memory here (a ring of live
 * proposals); the durable substrate in production is the orchestrator's approval_request + auto_action rows.
 */

import type { GateResult } from '@sho/contracts'

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
  status: 'proposed' | 'confirmed' | 'rejected'
}

export class RepairIndex {
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
