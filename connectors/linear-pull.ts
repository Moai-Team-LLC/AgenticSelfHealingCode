#!/usr/bin/env bun
/**
 * Pull incidents from Linear → connectors/incidents.json → run the D10 verdict.
 * Reads credentials ONLY from connectors/.env (gitignored). Never prints the key.
 *
 *   cp connectors/.env.example connectors/.env   # fill in LINEAR_API_KEY + LINEAR_STATE_*
 *   bun run connectors/linear-pull.ts
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { linearToIncidents, stateMapFromEnv, type LinearIssue } from '../d10-instrument/adapters/linear'
import { analyze, DEFAULT_CFG } from '../d10-instrument/d10'

// minimal .env loader (the file next to this script); does not override already-set env
function loadEnv(dir: string) {
  const p = join(dir, '.env')
  if (!existsSync(p)) return
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}

const QUERY = `query($after: String, $filter: IssueFilter) {
  issues(first: 100, after: $after, filter: $filter) {
    pageInfo { hasNextPage endCursor }
    nodes {
      identifier title createdAt startedAt completedAt
      team { key }
      labels { nodes { name } }
      history { nodes { createdAt toState { name } } }
    }
  }
}`

async function main() {
  const dir = import.meta.dir
  loadEnv(dir)
  const key = process.env.LINEAR_API_KEY
  if (!key) { console.error('LINEAR_API_KEY not set. Copy connectors/.env.example → connectors/.env and fill it in.'); process.exit(2) }

  const teamKey = process.env.LINEAR_TEAM_KEY?.trim()
  const filter = teamKey ? { team: { key: { eq: teamKey } } } : undefined

  const nodes: LinearIssue[] = []
  let after: string | undefined
  do {
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: key }, // personal API key: raw, no Bearer
      body: JSON.stringify({ query: QUERY, variables: { after, filter } }),
    })
    const json: any = await res.json()
    if (json.errors) { console.error('Linear GraphQL error:', JSON.stringify(json.errors, null, 2)); process.exit(1) }
    const page = json.data.issues
    nodes.push(...page.nodes)
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : undefined
  } while (after)

  const records = linearToIncidents(nodes, stateMapFromEnv(process.env))
  const out = join(dir, 'incidents.json')
  writeFileSync(out, JSON.stringify(records, null, 2))
  console.log(`Pulled ${records.length} issues → ${out} (gitignored)`)

  const a = analyze(records, DEFAULT_CFG)
  console.log(`\nD10 verdict: ${a.verdict.toUpperCase()} (confidence: ${a.confidence})`)
  console.log(`  decomposable ${a.counts.decomposable}/${a.counts.total} · median diagnosis share ${a.medianDiagnosisShare}`)
  if (a.counts.decomposable === 0) {
    console.log('  → No incident has both cause_confirmed_at and fix_deployed_at. Add a "root cause found" and a')
    console.log('    "deployed" state to your Linear incident workflow (map them in connectors/.env), then re-pull.')
  } else {
    console.log(`  Run: bun run d10-instrument/d10.ts ${out}   (full report + per-class breakdown)`)
  }
}

main()
