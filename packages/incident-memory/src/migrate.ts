/**
 * Migrations runner. Executes the @sho/contracts MIGRATIONS (the SHARED DDL — incident-memory and the
 * orchestrator run the SAME schema) via an injected executor, so the real pg wiring stays out of this
 * package and the runner is testable with a fake. Ordered, idempotent (the DDL is all IF NOT EXISTS).
 */

import { MIGRATIONS } from '@sho/contracts'

/** Injected SQL executor — the one seam to real Postgres. `params` is passed through for parity with query(). */
export type SqlExecutor = (sql: string, params?: unknown[]) => Promise<unknown[]>

export interface MigrationResult {
  name: string
}

/** Run every contract migration in dependency order. Returns the applied names for auditing. */
export async function runMigrations(exec: SqlExecutor): Promise<MigrationResult[]> {
  const applied: MigrationResult[] = []
  for (const m of MIGRATIONS) {
    await exec(m.sql)
    applied.push({ name: m.name })
  }
  return applied
}
