#!/usr/bin/env bun
/**
 * D10 — MTTR Bottleneck Instrument
 *
 * Answers the one question the reframe (D5) is conditional on: is your MTTR spent on
 * DIAGNOSIS (finding the cause) or REMEDIATION (shipping the fix)?
 *   - diagnosis-heavy  → build Loop A (RCA copilot) first.
 *   - remediation-heavy → fix CI/deploy/review friction first; earn Loop C per-class. Loop A is low-value.
 *
 * Input: a normalized JSON array of IncidentRecord (see README.md / the input contract below).
 * Output: text report (default) or machine JSON (--json). Zero dependencies. Run with: bun run d10.ts <file>
 *
 * See ../D10-INSTRUMENT.md for the methodology this implements, and ../ARCHITECTURE-REFRAMED.md §8.
 */

import { readFileSync } from 'node:fs'

// ---- Input contract -------------------------------------------------------

interface IncidentRecord {
  id: string
  service?: string // used as the class key for the per-class breakdown
  detected_at?: string // ISO 8601
  acknowledged_at?: string // ISO 8601 — diagnosis-span start (falls back to detected_at)
  cause_confirmed_at?: string // ISO 8601 — root cause established: diagnosis end / remediation start
  fix_deployed_at?: string // ISO 8601 — the fix hit production: remediation end
  resolved_at?: string // ISO 8601 — verified resolved
  resolution_type?: string // 'code_fix' | 'rollback' | 'config' | 'infra' | 'data' | 'no_action' | ...
}

interface Decomposed {
  id: string
  cls: string
  diagMin: number
  remedMin: number
  share: number // diagnosis share of decomposable MTTR = diag / (diag + remed)
  resolutionType: string
}
interface Excluded { id: string; reason: string }

// ---- Config (thresholds; overridable via flags) ---------------------------

interface Cfg { diagHeavy: number; remedHeavy: number; smallSample: number; lowConfExcluded: number }
const DEFAULT_CFG: Cfg = { diagHeavy: 0.6, remedHeavy: 0.4, smallSample: 20, lowConfExcluded: 0.5 }

// ---- Helpers --------------------------------------------------------------

function spanMin(a?: string, b?: string): number | null {
  if (!a || !b) return null
  const ta = Date.parse(a), tb = Date.parse(b)
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null
  return (tb - ta) / 60000
}
function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
function round(x: number | null, d = 2): number | null {
  if (x === null) return null
  const f = 10 ** d
  return Math.round(x * f) / f
}

// ---- Core analysis --------------------------------------------------------

function decompose(records: IncidentRecord[]): { decomposed: Decomposed[]; excluded: Excluded[] } {
  const decomposed: Decomposed[] = []
  const excluded: Excluded[] = []
  for (const r of records) {
    const start = r.acknowledged_at ?? r.detected_at
    if (!start) { excluded.push({ id: r.id, reason: 'no_start_ts' }); continue }
    if (!r.cause_confirmed_at) { excluded.push({ id: r.id, reason: 'no_cause_ts' }); continue }
    if (!r.fix_deployed_at) { excluded.push({ id: r.id, reason: 'no_fix_ts' }); continue }
    const diagMin = spanMin(start, r.cause_confirmed_at)
    const remedMin = spanMin(r.cause_confirmed_at, r.fix_deployed_at)
    if (diagMin === null || remedMin === null) { excluded.push({ id: r.id, reason: 'unparseable_ts' }); continue }
    if (diagMin < 0 || remedMin < 0) { excluded.push({ id: r.id, reason: 'nonpositive_span' }); continue }
    const total = diagMin + remedMin
    if (total <= 0) { excluded.push({ id: r.id, reason: 'degenerate_zero_total' }); continue }
    decomposed.push({
      id: r.id,
      cls: r.service ?? 'unknown',
      diagMin, remedMin,
      share: diagMin / total,
      resolutionType: r.resolution_type ?? 'unknown',
    })
  }
  return { decomposed, excluded }
}

function label(share: number | null, cfg: Cfg): 'diagnosis-heavy' | 'remediation-heavy' | 'mixed' | 'insufficient-data' {
  if (share === null) return 'insufficient-data'
  if (share >= cfg.diagHeavy) return 'diagnosis-heavy'
  if (share <= cfg.remedHeavy) return 'remediation-heavy'
  return 'mixed'
}

const RECOMMENDATION: Record<string, string> = {
  'diagnosis-heavy':
    'Build Loop A (RCA copilot) first. Diagnosis is the bottleneck, so grounded hypotheses + repro + prior-incident recall directly cut MTTR. (D5 holds; ARCHITECTURE-REFRAMED §8.)',
  'remediation-heavy':
    'Do NOT build Loop A first. The bottleneck is shipping the fix, not finding it — fix CI/deploy/review friction conventionally, and earn Loop C per-class on outcome data. Loop B (test-healing) still ships regardless.',
  'mixed':
    'Loop A is net-positive on the diagnosis-heavy classes only — prioritize by the per-class split below, not the aggregate. Loop B ships regardless.',
  'insufficient-data':
    'Not enough decomposable incidents to decide. Instrument your tracker to stamp cause_confirmed_at and fix_deployed_at, then re-run.',
}

function analyze(records: IncidentRecord[], cfg: Cfg) {
  const { decomposed, excluded } = decompose(records)
  const n = decomposed.length
  const shares = decomposed.map((d) => d.share)
  const medShare = median(shares)
  const aggShare =
    n > 0
      ? decomposed.reduce((s, d) => s + d.diagMin, 0) /
        decomposed.reduce((s, d) => s + d.diagMin + d.remedMin, 0)
      : null

  // per-class breakdown
  const byClass: Record<string, Decomposed[]> = {}
  for (const d of decomposed) (byClass[d.cls] ??= []).push(d)
  const classes = Object.entries(byClass)
    .map(([cls, ds]) => {
      const ms = median(ds.map((d) => d.share))
      return {
        cls, n: ds.length,
        medianDiagnosisShare: round(ms),
        medianDiagnosisMin: round(median(ds.map((d) => d.diagMin))),
        medianRemediationMin: round(median(ds.map((d) => d.remedMin))),
        verdict: label(ms, cfg),
      }
    })
    .sort((a, b) => (b.medianDiagnosisShare ?? 0) - (a.medianDiagnosisShare ?? 0))

  // Loop-C addressability: only code_fix remediations are in reach of auto-repair (§1/§15).
  const codeFix = decomposed.filter((d) => d.resolutionType === 'code_fix')
  const rollbacks = decomposed.filter((d) => d.resolutionType === 'rollback')

  const total = records.length
  const excludedFrac = total > 0 ? excluded.length / total : 0
  const verdict = label(medShare, cfg)
  const confidence =
    n === 0 ? 'none'
      : excludedFrac > cfg.lowConfExcluded ? 'low (majority of incidents not decomposable — instrument the tracker)'
      : n < cfg.smallSample ? 'moderate (small sample; treat as directional)'
      : 'ok'

  return {
    verdict,
    recommendation: RECOMMENDATION[verdict],
    confidence,
    counts: { total, decomposable: n, excluded: excluded.length },
    medianDiagnosisShare: round(medShare),
    aggregateDiagnosisShare: round(aggShare),
    medianDiagnosisMin: round(median(decomposed.map((d) => d.diagMin))),
    medianRemediationMin: round(median(decomposed.map((d) => d.remedMin))),
    loopCAddressable: {
      codeFixCount: codeFix.length,
      codeFixMedianRemediationMin: round(median(codeFix.map((d) => d.remedMin))),
      rollbackShare: round(n > 0 ? rollbacks.length / n : 0),
      note: 'Rollbacks/config/infra/data resolutions are outside code-only auto-repair (attack #1). High rollback or non-code share shrinks the Loop C tail further.',
    },
    classes,
    exclusionsByReason: excluded.reduce<Record<string, number>>((m, e) => ((m[e.reason] = (m[e.reason] ?? 0) + 1), m), {}),
    shares, // for the histogram
  }
}

// ---- Rendering ------------------------------------------------------------

function histogram(shares: number[]): string {
  const buckets = [0, 0, 0, 0, 0] // [0,0.2) [0.2,0.4) [0.4,0.6) [0.6,0.8) [0.8,1]
  for (const s of shares) buckets[Math.min(4, Math.floor(s * 5))]++
  const labels = ['0.0–0.2 remediation-heavy', '0.2–0.4', '0.4–0.6 mixed', '0.6–0.8', '0.8–1.0 diagnosis-heavy']
  const max = Math.max(1, ...buckets)
  return buckets
    .map((c, i) => `  ${labels[i].padEnd(26)} | ${'█'.repeat(Math.round((c / max) * 30))} ${c}`)
    .join('\n')
}

function renderText(a: ReturnType<typeof analyze>): string {
  const L: string[] = []
  L.push('══════════════════════════════════════════════════════════════════')
  L.push('  D10 — MTTR BOTTLENECK: diagnosis vs remediation')
  L.push('══════════════════════════════════════════════════════════════════')
  L.push('')
  L.push(`  VERDICT:  ${a.verdict.toUpperCase()}   (confidence: ${a.confidence})`)
  L.push(`  → ${a.recommendation}`)
  L.push('')
  L.push(`  incidents: ${a.counts.total} total · ${a.counts.decomposable} decomposable · ${a.counts.excluded} excluded`)
  L.push(`  median diagnosis share: ${a.medianDiagnosisShare}   (aggregate: ${a.aggregateDiagnosisShare})`)
  L.push(`  median diagnosis: ${a.medianDiagnosisMin} min   ·   median remediation: ${a.medianRemediationMin} min`)
  L.push('')
  L.push('  Diagnosis-share distribution (share of MTTR spent diagnosing):')
  L.push(histogram(a.shares))
  L.push('')
  L.push('  Per-class (prioritize Loop A by this, not the aggregate):')
  for (const c of a.classes) {
    L.push(`    ${c.cls.padEnd(14)} n=${String(c.n).padEnd(3)} share=${c.medianDiagnosisShare}  diag=${c.medianDiagnosisMin}m remed=${c.medianRemediationMin}m  → ${c.verdict}`)
  }
  L.push('')
  L.push('  Loop C addressability (only code fixes are in auto-repair reach — attack #1):')
  L.push(`    code_fix incidents: ${a.loopCAddressable.codeFixCount} · median code-fix remediation: ${a.loopCAddressable.codeFixMedianRemediationMin} min · rollback share: ${a.loopCAddressable.rollbackShare}`)
  if (a.counts.excluded > 0) {
    L.push('')
    L.push('  Excluded (not decomposable — the messy-data reality, D10-INSTRUMENT §3):')
    for (const [reason, n] of Object.entries(a.exclusionsByReason)) L.push(`    ${reason.padEnd(22)} ${n}`)
  }
  L.push('')
  L.push('══════════════════════════════════════════════════════════════════')
  return L.join('\n')
}

// ---- CLI ------------------------------------------------------------------

function parseArgs(argv: string[]): { file: string | null; json: boolean; cfg: Cfg } {
  const cfg = { ...DEFAULT_CFG }
  let file: string | null = null
  let json = false
  for (const arg of argv) {
    if (arg === '--json') json = true
    else if (arg.startsWith('--diag-heavy=')) cfg.diagHeavy = Number(arg.split('=')[1])
    else if (arg.startsWith('--remed-heavy=')) cfg.remedHeavy = Number(arg.split('=')[1])
    else if (!arg.startsWith('--')) file = arg
  }
  return { file, json, cfg }
}

function main() {
  const { file, json, cfg } = parseArgs(process.argv.slice(2))
  if (!file) {
    console.error('usage: bun run d10.ts <incidents.json> [--json] [--diag-heavy=0.6] [--remed-heavy=0.4]')
    process.exit(2)
  }
  let records: IncidentRecord[]
  try {
    records = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    console.error(`cannot read/parse ${file}: ${(e as Error).message}`)
    process.exit(2)
  }
  if (!Array.isArray(records)) {
    console.error('input must be a JSON array of IncidentRecord')
    process.exit(2)
  }
  const a = analyze(records, cfg)
  if (json) {
    const { shares, ...rest } = a
    console.log(JSON.stringify(rest, null, 2))
  } else {
    console.log(renderText(a))
  }
}

// Run only as a CLI; stay importable for tests.
if (import.meta.main) main()

export { analyze, decompose, median, label, DEFAULT_CFG }
export type { IncidentRecord }
