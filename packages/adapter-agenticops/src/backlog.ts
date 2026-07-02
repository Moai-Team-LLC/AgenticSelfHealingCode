/**
 * AgenticOpsBacklog — SHO's BacklogPort mapped onto the AgenticOps durable FIFO backlog
 * (AgenticOps/src/backlog/backlog.ts). The Backlog instance is INJECTED, duck-typed from the
 * real class's public surface.
 *
 * Idempotency: the real EnqueueOptions offers NO dedupe/idempotency key (only maxAttempts),
 * so the guard on WorkItem.id lives here, in an adapter-side map — per the port contract,
 * re-enqueueing an existing id (even after completion) is a no-op. The guard is per adapter
 * instance; the full WorkItem (including its id) rides as the task payload, so durable
 * consumers can dedupe downstream if an adapter restart re-enqueues.
 *
 * Completion: the real completion call is Backlog.complete(taskId) — it deletes the task and
 * carries no outcome field, so the SHO outcome string is retained adapter-side (inspectable
 * via outcomeFor); outcome reporting to the platform is the telemetry port's job (rca_outcome
 * / harm events), not the queue's.
 */

import type { BacklogPort, WorkItem } from '@sho/contracts'

// ── Duck-typed surface, copied from AgenticOps src/backlog/backlog.ts ────────
export interface AgenticOpsEnqueueOptions {
  maxAttempts?: number
}
export interface AgenticOpsBacklogLike {
  /** Real signature: enqueue(agent: string, payload: unknown, opts: EnqueueOptions = {}): number */
  enqueue(agent: string, payload: unknown, opts?: AgenticOpsEnqueueOptions): number
  /** Real signature: complete(id: number): void — deletes the task. */
  complete(id: number): void
}

export interface AgenticOpsBacklogOptions {
  /** BacklogTask.agent the work is queued for (who should claim it). Default 'sho'. */
  agent?: string
}

export class AgenticOpsBacklog implements BacklogPort {
  /** WorkItem.id → durable AgenticOps task id (+ terminal outcome once completed). */
  private readonly tasks = new Map<string, { taskId: number; outcome?: string }>()

  constructor(
    private readonly backlog: AgenticOpsBacklogLike,
    private readonly opts: AgenticOpsBacklogOptions = {},
  ) {}

  enqueue(item: WorkItem): void {
    if (this.tasks.has(item.id)) return // idempotent on item.id (port contract)
    const taskId = this.backlog.enqueue(this.opts.agent ?? 'sho', item)
    this.tasks.set(item.id, { taskId })
  }

  complete(id: string, outcome: string): void {
    const rec = this.tasks.get(id)
    if (!rec) return // unknown id: no-op, mirrors the in-repo default
    this.backlog.complete(rec.taskId)
    rec.outcome = outcome
  }

  /** Durable AgenticOps task id for a SHO WorkItem id (undefined if never enqueued here). */
  taskIdFor(id: string): number | undefined {
    return this.tasks.get(id)?.taskId
  }

  /** Terminal outcome recorded for a SHO WorkItem id (undefined until completed). */
  outcomeFor(id: string): string | undefined {
    return this.tasks.get(id)?.outcome
  }
}
