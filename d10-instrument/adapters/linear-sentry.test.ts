import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { linearToIncidents, stateMapFromEnv, type LinearIssue, type LinearStateMap } from './linear'
import { sentryToIncidents, type SentryIssue } from './sentry'
import { analyze, DEFAULT_CFG } from '../d10'

const load = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'))

const STATE_MAP: LinearStateMap = {
  acknowledged: ['In Progress'],
  causeConfirmed: ['Root Cause Found'],
  fixDeployed: ['Deployed'],
  resolved: ['Done'],
}

test('Linear: state-transition history → contract timestamps', () => {
  const recs = linearToIncidents(load('../fixtures/linear.sample.json') as LinearIssue[], STATE_MAP)
  expect(recs.length).toBe(3)
  const e1 = recs.find((r) => r.id === 'ENG-1')!
  expect(e1.service).toBe('ENG')
  expect(e1.detected_at).toBe('2026-06-01T09:00:00.000Z')
  expect(e1.acknowledged_at).toBe('2026-06-01T09:02:00.000Z') // → In Progress
  expect(e1.cause_confirmed_at).toBe('2026-06-01T09:50:00.000Z') // → Root Cause Found
  expect(e1.fix_deployed_at).toBe('2026-06-01T10:00:00.000Z') // → Deployed
  expect(e1.resolution_type).toBe('code_fix') // from labels
})

test('Linear: missing "Root Cause Found" → cause undefined; fix falls back to completedAt', () => {
  const recs = linearToIncidents(load('../fixtures/linear.sample.json') as LinearIssue[], STATE_MAP)
  const e2 = recs.find((r) => r.id === 'ENG-2')!
  expect(e2.cause_confirmed_at).toBeUndefined()
  expect(e2.fix_deployed_at).toBe('2026-06-01T13:05:00.000Z') // completedAt fallback (no Deployed state)
})

test('Linear → analyze: only issues with a cause timestamp decompose', () => {
  const recs = linearToIncidents(load('../fixtures/linear.sample.json') as LinearIssue[], STATE_MAP)
  const a = analyze(recs, DEFAULT_CFG)
  expect(a.counts.decomposable).toBe(2) // ENG-1, OPS-3
  expect(a.exclusionsByReason['no_cause_ts']).toBe(1) // ENG-2
})

test('Linear: without a mapped cause state, nothing decomposes (the honest gap)', () => {
  const recs = linearToIncidents(load('../fixtures/linear.sample.json') as LinearIssue[], { acknowledged: ['In Progress'], resolved: ['Done'] })
  expect(analyze(recs, DEFAULT_CFG).counts.decomposable).toBe(0)
})

test('stateMapFromEnv parses comma-separated names', () => {
  const m = stateMapFromEnv({ LINEAR_STATE_CAUSE_CONFIRMED: 'Root Cause Found, Diagnosed', LINEAR_STATE_FIX_DEPLOYED: 'Deployed' })
  expect(m.causeConfirmed).toEqual(['Root Cause Found', 'Diagnosed'])
  expect(m.fixDeployed).toEqual(['Deployed'])
  expect(m.acknowledged).toBeUndefined()
})

test('Sentry: detection only — detected_at + service, lifecycle undefined', () => {
  const recs = sentryToIncidents(load('../fixtures/sentry.sample.json') as SentryIssue[])
  expect(recs.length).toBe(2)
  const s1 = recs.find((r) => r.id === 'BACKEND-1')!
  expect(s1.service).toBe('backend')
  expect(s1.detected_at).toBe('2026-06-01T08:58:00.000Z')
  expect(s1.cause_confirmed_at).toBeUndefined()
  expect(s1.fix_deployed_at).toBeUndefined()
  expect(s1.resolved_at).toBeUndefined() // NOT mapped from lastSeen
  expect(recs.find((r) => r.id === '4502')!.id).toBe('4502') // falls back to id when no shortId
})
