/**
 * The incident lifecycle state machine + the notify_state CAS (ARCHITECTURE-REFRAMED §1/§5,
 * coherence BLOCKER #4). The durable substrate is AgenticOps Postgres (D1); this is the pure transition
 * logic + the compare-and-set that guarantees no double-notify and race-safety with human resolution.
 */

export type IncidentState =
  | 'ingested' | 'deduped' | 'investigating' | 'notified'
  | 'awaiting_human' | 'auto_applying' | 'verifying' | 'landed' | 'outcome_watch' | 'closed'

const TRANSITIONS: Record<IncidentState, IncidentState[]> = {
  ingested: ['deduped'],
  deduped: ['investigating', 'closed'], // dropped as noise → closed
  investigating: ['notified', 'closed'], // RCA below threshold still notifies; nothing actionable → closed
  notified: ['awaiting_human', 'auto_applying', 'closed'],
  awaiting_human: ['verifying', 'closed'], // human approves a fix/heal, or resolves out-of-band
  auto_applying: ['verifying', 'closed'],
  verifying: ['landed', 'awaiting_human', 'closed'], // gate pass → landed; reject → back to human
  landed: ['outcome_watch'],
  outcome_watch: ['closed'],
  closed: [],
}

export function canTransition(from: IncidentState, to: IncidentState): boolean {
  return TRANSITIONS[from].includes(to)
}

/** Coarse projection onto incident_memory.incidents.status (coherence #9, owned here). */
export function statusProjection(state: IncidentState): 'open' | 'diagnosed' | 'resolved' | 'closed' {
  switch (state) {
    case 'ingested': case 'deduped': return 'open'
    case 'investigating': case 'notified': case 'awaiting_human': case 'auto_applying': case 'verifying': case 'landed':
      return 'diagnosed'
    case 'outcome_watch': return 'resolved'
    case 'closed': return 'closed'
  }
}

// ── notify_state CAS ────────────────────────────────────────────────────────

export type NotifyState = 'investigating' | 'notified'

/** Durable compare-and-set. The orchestrator owns the column; Loop A's emit() performs this exact CAS
 *  as the orchestrator-invoked delivery step (single writer, no double-notify). */
export class NotifyStore {
  private state = new Map<string, NotifyState>()
  /** Returns true iff THIS call performed investigating→notified (the caller then delivers). */
  casNotified(incidentId: string): boolean {
    const cur = this.state.get(incidentId) ?? 'investigating'
    if (cur === 'notified') return false // already delivered — do not double-notify
    this.state.set(incidentId, 'notified')
    return true
  }
  get(incidentId: string): NotifyState { return this.state.get(incidentId) ?? 'investigating' }
}
