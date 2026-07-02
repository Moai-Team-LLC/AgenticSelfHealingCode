import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { csvToIncidents, parseCsv } from './csv'
import { pagerDutyToIncidents } from './pagerduty'
import { enrichWithDeploys, enrichWithGit, parseGitLog } from './enrich'
import { analyze, DEFAULT_CFG } from '../d10'

const load = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')

test('CSV: alias mapping + quoted comma field + empty cells', () => {
  const recs = csvToIncidents(load('../fixtures/incidents.sample.csv'))
  expect(recs.length).toBe(3)
  const inc1 = recs.find((r) => r.id === 'INC-1')!
  expect(inc1.service).toBe('checkout')
  expect(inc1.cause_confirmed_at).toBe('2026-06-01T09:50:00Z') // diagnosed_at alias
  expect(inc1.fix_deployed_at).toBe('2026-06-01T10:00:00Z') // deployed_at alias
  const inc2 = recs.find((r) => r.id === 'INC-2')!
  expect(inc2.service).toBe('payments, billing') // quoted comma preserved
  expect(inc2.cause_confirmed_at).toBeUndefined() // empty cell → undefined, not ''
})

test('CSV → analyze: rows with a cause timestamp decompose', () => {
  const recs = csvToIncidents(load('../fixtures/incidents.sample.csv'))
  const a = analyze(recs, DEFAULT_CFG)
  expect(a.counts.decomposable).toBe(2) // INC-1 and INC-3; INC-2 lacks cause → excluded
  expect(a.exclusionsByReason['no_cause_ts']).toBe(1)
})

test('parseCsv handles embedded quotes', () => {
  const rows = parseCsv('a,b\n"x ""q"" y",2\n')
  expect(rows[1][0]).toBe('x "q" y')
})

test('PagerDuty: maps detection/ack/resolve, leaves cause/fix undefined', () => {
  const recs = pagerDutyToIncidents(JSON.parse(load('../fixtures/pagerduty.sample.json')))
  const p1 = recs.find((r) => r.id === 'PABC1')!
  expect(p1.detected_at).toBe('2026-06-01T08:00:00Z')
  expect(p1.acknowledged_at).toBe('2026-06-01T08:03:00Z')
  expect(p1.resolved_at).toBe('2026-06-01T09:15:00Z')
  expect(p1.service).toBe('api')
  expect(p1.cause_confirmed_at).toBeUndefined()
  expect(p1.fix_deployed_at).toBeUndefined()
  const p2 = recs.find((r) => r.id === 'PABC2')!
  expect(p2.resolved_at).toBe('2026-06-01T16:00:00Z') // from resolved_at field
})

test('enrichWithDeploys: earliest linked deploy fills fix_deployed_at', () => {
  const recs = pagerDutyToIncidents(JSON.parse(load('../fixtures/pagerduty.sample.json')))
  const deploys = JSON.parse(load('../fixtures/deploys.sample.json'))
  const enriched = enrichWithDeploys(recs, deploys)
  expect(enriched.find((r) => r.id === 'PABC1')!.fix_deployed_at).toBe('2026-06-01T09:05:00.000Z') // earliest of the two
  expect(enriched.find((r) => r.id === 'PABC2')!.fix_deployed_at).toBe('2026-06-01T16:30:00.000Z')
})

test('PagerDuty stays non-decomposable without a cause timestamp (the honest truth)', () => {
  const recs = pagerDutyToIncidents(JSON.parse(load('../fixtures/pagerduty.sample.json')))
  const enriched = enrichWithDeploys(recs, JSON.parse(load('../fixtures/deploys.sample.json')))
  const a = analyze(enriched, DEFAULT_CFG)
  expect(a.counts.decomposable).toBe(0) // even with fix time, no cause_confirmed_at → cannot split
  expect(a.exclusionsByReason['no_cause_ts']).toBe(2)
})

test('enrichWithGit: earliest commit referencing the id fills fix_deployed_at', () => {
  const commits = parseGitLog(
    '2026-06-01T09:20:00Z\tunrelated change\n2026-06-01T09:07:00Z\tFixes PABC1: add null guard\n2026-06-01T09:30:00Z\tPABC1 follow-up',
  )
  const recs = [{ id: 'PABC1', detected_at: '2026-06-01T08:00:00Z' }]
  const enriched = enrichWithGit(recs, commits, (id) => new RegExp(`\\b${id}\\b`))
  expect(enriched[0].fix_deployed_at).toBe('2026-06-01T09:07:00.000Z')
})
