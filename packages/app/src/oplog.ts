/**
 * A lightweight operational log of processed signals — the read model behind GET /incidents and
 * GET /status. In-memory ring buffer (last `cap`), independent of the durable incident memory, so the
 * ops surface works identically on fakes and on Postgres. It records what the on-call needs to see:
 * what came in, how it was diagnosed, whether it paged, and whether a human acknowledged it.
 */

export interface IncidentLogEntry {
  incidentId: string
  classKey: string
  gate: 'CONFIRMED' | 'ESCALATE'
  correlationState: string
  priority: number
  delivered: boolean
  suspicious: boolean
  at: string
  ackedBy?: string
  ackedAt?: string
}

export interface IncidentStats {
  total: number
  delivered: number
  escalated: number
  suspicious: number
  acked: number
}

export class IncidentLog {
  private buf: IncidentLogEntry[] = []
  constructor(private readonly cap = 500) {}

  record(e: IncidentLogEntry): void {
    this.buf.push(e)
    if (this.buf.length > this.cap) this.buf.shift()
  }

  /** Most-recent first. */
  list(limit = 50): IncidentLogEntry[] {
    return this.buf.slice(-limit).reverse()
  }

  get(id: string): IncidentLogEntry | undefined {
    for (let i = this.buf.length - 1; i >= 0; i--) if (this.buf[i]!.incidentId === id) return this.buf[i]
    return undefined
  }

  /** Record a human acknowledgement (from the Telegram callback). Returns false if the id is unknown. */
  markAck(id: string, by: string, at: string): boolean {
    const e = this.get(id)
    if (!e) return false
    e.ackedBy = by
    e.ackedAt = at
    return true
  }

  stats(): IncidentStats {
    return {
      total: this.buf.length,
      delivered: this.buf.filter((e) => e.delivered).length,
      escalated: this.buf.filter((e) => e.gate === 'ESCALATE').length,
      suspicious: this.buf.filter((e) => e.suspicious).length,
      acked: this.buf.filter((e) => e.ackedBy).length,
    }
  }
}
