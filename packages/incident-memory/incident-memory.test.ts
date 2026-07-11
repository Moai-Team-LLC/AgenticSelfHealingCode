import { test, expect } from 'bun:test'
import type { IncidentCandidate, OutcomeEvent } from '@sho/contracts'
import { WINDOWS_DAYS } from '@sho/contracts'
import {
  InMemoryIncidentMemory,
  runMigrations,
  polarityOf,
  moduleAreaOf,
  symptomSignatureOf,
  type IncidentRecord,
  type ResolutionRecord,
  type SqlExecutor,
} from './src/index'

const DAY = 86_400_000
const NOW = Date.parse('2026-07-01T00:00:00.000Z')

const inc = (o: Partial<IncidentRecord> & { id: string }): IncidentRecord => ({
  fingerprint: `fp-${o.id}`,
  symptomSignature: `sig-${o.id}`,
  moduleArea: 'src/checkout',
  signalText: 'TypeError cannot read price of undefined',
  firstSeenMs: NOW - 5 * DAY, // inside W_recur for recurrence tests; retrieval tests ignore this field
  ...o,
})

const res = (o: Partial<ResolutionRecord> & { id: string; incidentId: string }): ResolutionRecord => ({
  classKey: 'src/checkout::sig',
  outcomeLabel: 'applied',
  rationaleText: 'add null guard around price lookup',
  createdAtMs: NOW - 30 * DAY,
  ...o,
})

const candidate = (o: Partial<IncidentCandidate> & { fingerprint: string }): IncidentCandidate => ({
  id: o.id ?? o.fingerprint,
  source: 'sentry',
  severity: 3,
  first_seen: new Date(NOW).toISOString(),
  occurrences: 1,
  affected_service: 'checkout',
  affected_paths: ['src/checkout/price.ts'],
  recent_deploys: [],
  shape: 'step',
  raw_payload: {},
  ...o,
})

// ── outcome-weighted retrieval polarity (attack #8) ─────────────────────────

test('retrieval polarity: confirmed_good is exemplar, failures are anti-patterns, never neutral', () => {
  const m = new InMemoryIncidentMemory()
  m.recordIncident(inc({ id: 'i1' }))
  m.recordIncident(inc({ id: 'i2' }))
  m.recordIncident(inc({ id: 'i3' }))
  // same rationale text → identical similarity; polarity is what separates them
  m.recordResolution(res({ id: 'r1', incidentId: 'i1', actionId: 'a1', outcomeLabel: 'confirmed_good' }))
  m.recordResolution(res({ id: 'r2', incidentId: 'i2', actionId: 'a2', outcomeLabel: 'recurred' }))
  m.recordResolution(res({ id: 'r3', incidentId: 'i3', actionId: 'a3', outcomeLabel: 'reverted' }))

  const out = m.retrieveSimilar('add null guard around price lookup', 5)
  expect(out.exemplars.map((h) => h.resolution.id)).toEqual(['r1'])
  expect(out.exemplars[0]!.polarity).toBe('exemplar')
  // both failures come back, in the anti-pattern block, labeled — never as neutral matches
  expect(out.antiPatterns.map((h) => h.resolution.id).sort()).toEqual(['r2', 'r3'])
  expect(out.antiPatterns.every((h) => h.polarity === 'anti-pattern')).toBe(true)
  expect(out.antiPatterns.every((h) => h.weight < 0)).toBe(true)
})

test('retrieval: a failed resolution is NEVER returned in the exemplar (neutral/positive) block', () => {
  const m = new InMemoryIncidentMemory()
  m.recordIncident(inc({ id: 'i1' }))
  m.recordResolution(res({ id: 'r1', incidentId: 'i1', actionId: 'a1', outcomeLabel: 'wrong_rca' }))
  const out = m.retrieveSimilar('add null guard around price lookup', 5)
  expect(out.exemplars).toHaveLength(0)
  expect(out.antiPatterns).toHaveLength(1)
  expect(out.antiPatterns[0]!.polarity).toBe('anti-pattern')
})

test('retrieval polarity: confirmed_good outranks a weak/provisional positive at equal similarity (D6)', () => {
  const m = new InMemoryIncidentMemory()
  m.recordIncident(inc({ id: 'i1' }))
  m.recordIncident(inc({ id: 'i2' }))
  m.recordResolution(res({ id: 'weak', incidentId: 'i1', actionId: 'a1', outcomeLabel: 'provisional_human_confirmed' }))
  m.recordResolution(res({ id: 'good', incidentId: 'i2', actionId: 'a2', outcomeLabel: 'confirmed_good' }))
  const out = m.retrieveSimilar('add null guard around price lookup', 5)
  expect(out.exemplars.map((h) => h.resolution.id)).toEqual(['good', 'weak']) // proven precedent first
  expect(out.exemplars[0]!.polarity).toBe('exemplar')
  expect(out.exemplars[1]!.polarity).toBe('weak')
})

test('retrieval: superseded resolutions are filtered out entirely (not neutral, not anti-pattern)', () => {
  const m = new InMemoryIncidentMemory()
  m.recordIncident(inc({ id: 'i1' }))
  m.recordResolution(res({ id: 'old', incidentId: 'i1', actionId: 'a1', outcomeLabel: 'confirmed_good', supersededBy: 'new', createdAtMs: NOW - 40 * DAY }))
  m.recordResolution(res({ id: 'new', incidentId: 'i1', actionId: 'a2', outcomeLabel: 'applied', createdAtMs: NOW - 10 * DAY }))
  const out = m.retrieveSimilar('add null guard around price lookup', 5)
  // one row per incident: the current (non-superseded) one only
  expect(out.exemplars.map((h) => h.resolution.id)).toEqual(['new'])
})

test('polarityOf classifies the label enum correctly', () => {
  expect(polarityOf('confirmed_good')).toBe('exemplar')
  expect(polarityOf('applied')).toBe('weak')
  expect(polarityOf('provisional_human_confirmed')).toBe('weak')
  expect(polarityOf('recurred')).toBe('anti-pattern')
  expect(polarityOf('reverted')).toBe('anti-pattern')
  expect(polarityOf('wrong_rca')).toBe('anti-pattern')
  expect(polarityOf('superseded')).toBe('neutral')
})

// ── label enforcement ───────────────────────────────────────────────────────

test('setOutcomeLabel: confirmed_good requires a landed action (no exemplar from a zero-write row)', () => {
  const m = new InMemoryIncidentMemory()
  m.recordIncident(inc({ id: 'i1' }))
  m.recordResolution(res({ id: 'r1', incidentId: 'i1', outcomeLabel: 'proposed' })) // no actionId
  expect(() => m.setOutcomeLabel('r1', 'confirmed_good')).toThrow(/requires a landed action/)
  // provisional_human_confirmed is the weak, allowed path for an rca-only row
  m.setOutcomeLabel('r1', 'provisional_human_confirmed')
  expect(m.retrieveSimilar('add null guard', 5).exemplars[0]!.polarity).toBe('weak')
})

// ── projector: keys on actionId + matures only after W_mature ────────────────

test('projectOutcomeEvents keys on actionId, emits applied, and matures only at applied_at + W_mature', () => {
  const m = new InMemoryIncidentMemory()
  m.recordIncident(inc({ id: 'i1' }))
  // applied 20 days ago, confirmed_good label — but W_mature is 30d, so NOT matured yet
  m.recordResolution(res({ id: 'r1', incidentId: 'i1', classKey: 'ck', actionId: 'act-1', outcomeLabel: 'confirmed_good', appliedAtMs: NOW - 20 * DAY }))
  const early = m.projectOutcomeEvents('ck', NOW)
  expect(early.map((e) => e.kind)).toEqual(['applied']) // no premature matured
  expect(early.every((e) => e.actionId === 'act-1')).toBe(true)

  // now 40 days after apply → matured emitted, keyed on the canonical actionId field
  const late = m.projectOutcomeEvents('ck', NOW + 20 * DAY)
  const kinds = late.map((e) => e.kind).sort()
  expect(kinds).toEqual(['applied', 'matured'])
  const matured = late.find((e) => e.kind === 'matured')!
  expect(matured.actionId).toBe('act-1')
  expect(Date.parse(matured.at)).toBe((NOW - 20 * DAY) + WINDOWS_DAYS.W_mature * DAY)
})

test('projector maps recurred→recurrence, reverted→revert (§5.4), and skips rca-only (no actionId)', () => {
  const m = new InMemoryIncidentMemory()
  m.recordIncident(inc({ id: 'i1' }))
  m.recordIncident(inc({ id: 'i2' }))
  m.recordIncident(inc({ id: 'i3' }))
  m.recordResolution(res({ id: 'r1', incidentId: 'i1', classKey: 'ck', actionId: 'act-1', outcomeLabel: 'recurred', appliedAtMs: NOW - 10 * DAY }))
  m.recordResolution(res({ id: 'r2', incidentId: 'i2', classKey: 'ck', actionId: 'act-2', outcomeLabel: 'reverted', appliedAtMs: NOW - 10 * DAY }))
  m.recordResolution(res({ id: 'r3', incidentId: 'i3', classKey: 'ck', outcomeLabel: 'confirmed_good' })) // rca-only: no actionId → never emitted
  const evs = m.projectOutcomeEvents('ck', NOW)
  const byAction = (id: string) => evs.filter((e) => e.actionId === id).map((e) => e.kind).sort()
  expect(byAction('act-1')).toEqual(['applied', 'recurrence'])
  expect(byAction('act-2')).toEqual(['applied', 'revert'])
  expect(evs.some((e) => e.actionId === undefined)).toBe(false)
})

test('projectOutcomeEvents is idempotent — same input yields the same event set', () => {
  const m = new InMemoryIncidentMemory()
  m.recordIncident(inc({ id: 'i1' }))
  m.recordResolution(res({ id: 'r1', incidentId: 'i1', classKey: 'ck', actionId: 'act-1', outcomeLabel: 'confirmed_good', appliedAtMs: NOW - 40 * DAY }))
  const a = m.projectOutcomeEvents('ck', NOW)
  const b = m.projectOutcomeEvents('ck', NOW)
  expect(a).toEqual(b)
  // exactly one 'applied' per action id (idempotent on actionId), one 'matured'
  expect(a.filter((e) => e.kind === 'applied')).toHaveLength(1)
})

// ── drift-resistant recurrence ──────────────────────────────────────────────

test('detectRecurrence rung 1: exact fingerprint match', () => {
  const m = new InMemoryIncidentMemory()
  m.recordIncident(inc({ id: 'i1', fingerprint: 'fp-shared' }))
  const r = m.detectRecurrence(candidate({ fingerprint: 'fp-shared' }), NOW)
  expect(r).toEqual({ recurred: true, priorIncidentId: 'i1', basis: 'fingerprint' })
})

test('detectRecurrence rung 2: fingerprint drifted (refactor) but symptom_signature + module_area match', () => {
  const m = new InMemoryIncidentMemory()
  const cand = candidate({ fingerprint: 'fp-new-after-refactor' })
  // prior has a DIFFERENT fingerprint (drift) but the same rename-proof symptom_signature + area
  m.recordIncident(inc({ id: 'i1', fingerprint: 'fp-old', symptomSignature: symptomSignatureOf(cand), moduleArea: moduleAreaOf(cand) }))
  const r = m.detectRecurrence(cand, NOW)
  expect(r.recurred).toBe(true)
  expect(r.priorIncidentId).toBe('i1')
  expect(r.basis).toBe('symptom_area') // did NOT go dark on fingerprint drift
})

test('detectRecurrence rung 3: all structured keys miss but the injected vector fn matches', () => {
  const m = new InMemoryIncidentMemory()
  m.recordIncident(inc({ id: 'i1', fingerprint: 'fp-x', symptomSignature: 'sig-x', moduleArea: 'src/other', firstSeenMs: NOW - 5 * DAY }))
  const cand = candidate({ fingerprint: 'fp-y' }) // no structured overlap at all
  const vectorMatch = () => true // semantically near
  const r = m.detectRecurrence(cand, NOW, vectorMatch)
  expect(r).toEqual({ recurred: true, priorIncidentId: 'i1', basis: 'vector' })
})

test('detectRecurrence: concludes no-recurrence ONLY after trying every rung (vector included)', () => {
  const m = new InMemoryIncidentMemory()
  m.recordIncident(inc({ id: 'i1', fingerprint: 'fp-x', symptomSignature: 'sig-x', moduleArea: 'src/other', firstSeenMs: NOW - 5 * DAY }))
  let vectorTried = false
  const vectorMatch = () => {
    vectorTried = true
    return false
  }
  const r = m.detectRecurrence(candidate({ fingerprint: 'fp-y' }), NOW, vectorMatch)
  expect(r.recurred).toBe(false)
  expect(r.basis).toBeNull()
  expect(vectorTried).toBe(true) // the vector rung WAS exhausted before concluding "no recurrence"
})

test('detectRecurrence: a prior older than W_recur is not a recurrence (attribution window)', () => {
  const m = new InMemoryIncidentMemory()
  const cand = candidate({ fingerprint: 'fp-shared' })
  // same fingerprint, but first seen 60d ago — well past W_recur (14d)
  m.recordIncident(inc({ id: 'i1', fingerprint: 'fp-shared', firstSeenMs: NOW - 60 * DAY }))
  const r = m.detectRecurrence(cand, NOW)
  expect(r.recurred).toBe(false)
})

test('detectRecurrence: structured match wins over vector even when vector would also fire', () => {
  const m = new InMemoryIncidentMemory()
  const cand = candidate({ fingerprint: 'fp-drift' })
  m.recordIncident(inc({ id: 'i1', fingerprint: 'fp-old', symptomSignature: symptomSignatureOf(cand), moduleArea: moduleAreaOf(cand) }))
  const r = m.detectRecurrence(cand, NOW, () => true)
  expect(r.basis).toBe('symptom_area') // structured rung short-circuits; vector is last resort only
})

// ── harm query ──────────────────────────────────────────────────────────────

test('harmQuery counts caused resolutions over BOTH applied_by variants, deduped per actionId', () => {
  const m = new InMemoryIncidentMemory()
  for (const id of ['i1', 'i2', 'i3', 'i4']) m.recordIncident(inc({ id }))
  // machine landing that recurred, human_approved landing that reverted — both count as harm
  m.recordResolution(res({ id: 'r1', incidentId: 'i1', classKey: 'ck', actionId: 'machine-1', outcomeLabel: 'recurred' }))
  m.recordResolution(res({ id: 'r2', incidentId: 'i2', classKey: 'ck', actionId: 'human-1', outcomeLabel: 'reverted' }))
  // a confirmed_good does not count as harm
  m.recordResolution(res({ id: 'r3', incidentId: 'i3', classKey: 'ck', actionId: 'machine-2', outcomeLabel: 'confirmed_good' }))
  // a caused row with NO actionId (rca-only) is not an auto-action harm
  m.recordResolution(res({ id: 'r4', incidentId: 'i4', classKey: 'ck', outcomeLabel: 'wrong_rca' }))
  expect(m.harmQuery('ck')).toBe(2)
})

test('harmQuery dedups a single action that both recurred and got reverted → one caused-action', () => {
  const m = new InMemoryIncidentMemory()
  m.recordIncident(inc({ id: 'i1' }))
  m.recordIncident(inc({ id: 'i2' }))
  // two resolution rows sharing the same actionId, both caused → still ONE distinct caused action
  m.recordResolution(res({ id: 'r1', incidentId: 'i1', classKey: 'ck', actionId: 'act-1', outcomeLabel: 'recurred' }))
  m.recordResolution(res({ id: 'r2', incidentId: 'i2', classKey: 'ck', actionId: 'act-1', outcomeLabel: 'reverted' }))
  expect(m.harmQuery('ck')).toBe(1)
})

test('harmQuery is scoped per class', () => {
  const m = new InMemoryIncidentMemory()
  m.recordIncident(inc({ id: 'i1' }))
  m.recordIncident(inc({ id: 'i2' }))
  m.recordResolution(res({ id: 'r1', incidentId: 'i1', classKey: 'ckA', actionId: 'a1', outcomeLabel: 'recurred' }))
  m.recordResolution(res({ id: 'r2', incidentId: 'i2', classKey: 'ckB', actionId: 'a2', outcomeLabel: 'reverted' }))
  expect(m.harmQuery('ckA')).toBe(1)
  expect(m.harmQuery('ckB')).toBe(1)
  expect(m.harmQuery('ckC')).toBe(0)
})

// ── migrations runner (injected executor) ───────────────────────────────────

test('runMigrations executes every contract migration in order via the injected executor', async () => {
  const seen: string[] = []
  const exec: SqlExecutor = async (sql) => {
    seen.push(sql)
    return []
  }
  const applied = await runMigrations(exec)
  expect(applied.map((a) => a.name)).toEqual(['0001_auto_action', '0002_incidents', '0003_resolutions', '0004_trust_class', '0005_why_traces', '0006_retrieve_fn', '0007_kill_switch', '0008_repair_proposal'])
  expect(seen).toHaveLength(8)
  expect(seen[0]).toContain('orch.auto_action') // ran the real contract DDL, not a placeholder
})

// ── the seam: projected events are consumable by the controller's contract ──

test('projected events satisfy the controller OutcomeEvent contract (actionId/kind/at)', () => {
  const m = new InMemoryIncidentMemory()
  m.recordIncident(inc({ id: 'i1' }))
  m.recordResolution(res({ id: 'r1', incidentId: 'i1', classKey: 'ck', actionId: 'act-1', outcomeLabel: 'confirmed_good', appliedAtMs: NOW - 40 * DAY }))
  const evs: OutcomeEvent[] = m.projectOutcomeEvents('ck', NOW)
  for (const e of evs) {
    expect(typeof e.actionId).toBe('string')
    expect(['applied', 'recurrence', 'spawn', 'spawn_contested', 'revert', 'matured']).toContain(e.kind)
    expect(Number.isFinite(Date.parse(e.at))).toBe(true)
  }
})
