#!/usr/bin/env bun
/**
 * Apply the contract migrations (@sho/contracts MIGRATIONS) to DATABASE_URL. Idempotent — every DDL
 * statement is IF NOT EXISTS / OR REPLACE, so re-running is safe.
 *
 *   DATABASE_URL=postgres://postgres:sho@localhost:54329/sho bun run migrate
 */

import { SQL } from 'bun'
import { MIGRATIONS } from '@sho/contracts'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set.\n  example: DATABASE_URL=postgres://postgres:sho@localhost:54329/sho bun run migrate')
  process.exit(2)
}

const sql = new SQL(url)
try {
  for (const m of MIGRATIONS) {
    await sql.unsafe(m.sql)
    console.log(`  ✓ ${m.name}`)
  }
  console.log(`\n✅ ${MIGRATIONS.length} migrations applied (idempotent — safe to re-run)`)
} catch (e) {
  console.error(`❌ migration failed: ${String(e).slice(0, 300)}`)
  process.exit(1)
} finally {
  await sql.end()
}
