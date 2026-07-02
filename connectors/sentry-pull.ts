#!/usr/bin/env bun
/**
 * Pull issues from Sentry → connectors/sentry-incidents.json. Detection signals only (see
 * d10-instrument/adapters/sentry.ts): use to enrich Linear data or feed adapters/enrich.ts, not as a
 * standalone MTTR source. Reads credentials ONLY from connectors/.env (gitignored). Never prints them.
 *
 *   bun run connectors/sentry-pull.ts
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sentryToIncidents, type SentryIssue } from '../d10-instrument/adapters/sentry'

function loadEnv(dir: string) {
  const p = join(dir, '.env')
  if (!existsSync(p)) return
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}

async function main() {
  const dir = import.meta.dir
  loadEnv(dir)
  const token = process.env.SENTRY_AUTH_TOKEN
  const org = process.env.SENTRY_ORG
  const project = process.env.SENTRY_PROJECT
  if (!token || !org || !project) {
    console.error('Set SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT in connectors/.env.')
    process.exit(2)
  }

  // First page of issues. Sentry paginates via the Link header (rel="next", results="true") — follow
  // it for a full pull; kept single-page here for a bounded reference fetch.
  const res = await fetch(`https://sentry.io/api/0/projects/${org}/${project}/issues/?statsPeriod=90d`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) { console.error(`Sentry API ${res.status}: ${await res.text()}`); process.exit(1) }
  const issues = (await res.json()) as SentryIssue[]

  const records = sentryToIncidents(issues)
  const out = join(dir, 'sentry-incidents.json')
  writeFileSync(out, JSON.stringify(records, null, 2))
  console.log(`Pulled ${records.length} Sentry issues → ${out} (gitignored)`)
  console.log('Note: Sentry gives detected_at + service only. Pair with Linear + a deploy log (adapters/enrich.ts) to decompose MTTR.')
}

main()
