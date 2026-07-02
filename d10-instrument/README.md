# D10 — MTTR Bottleneck Instrument

Runnable implementation of `../D10-INSTRUMENT.md`. Answers the one question the reframe (D5,
`../DECISIONS.md`) is **conditional** on: is your MTTR spent on **diagnosis** (finding the cause)
or **remediation** (shipping the fix)?

- **diagnosis-heavy** → build **Loop A** (RCA copilot) first — grounded hypotheses + repro +
  prior-incident recall cut MTTR directly.
- **remediation-heavy** → do **not** build Loop A first — fix CI/deploy/review friction
  conventionally, earn **Loop C** per-class on outcome data. Loop B (test-healing) ships either way.
- **mixed** → Loop A is net-positive only on the diagnosis-heavy *classes* — prioritize by the
  per-class split, not the aggregate.

Tier 0: read-only, offline, no writes, no network. Zero dependencies.

## Run

```bash
bun run d10.ts fixtures/incidents.sample.json          # text report
bun run d10.ts fixtures/incidents.sample.json --json   # machine-readable
bun test                                               # unit tests
```

Thresholds are overridable: `--diag-heavy=0.6 --remed-heavy=0.4`.

## Input contract

A JSON array of incident records. Only the timestamps you have are required; missing ones move a
record into the **excluded** bucket (reported, never silently dropped).

```ts
interface IncidentRecord {
  id: string
  service?: string            // class key for the per-class breakdown
  detected_at?: string        // ISO 8601
  acknowledged_at?: string    // ISO — diagnosis-span START (falls back to detected_at)
  cause_confirmed_at?: string // ISO — root cause established: diagnosis END / remediation START
  fix_deployed_at?: string    // ISO — fix hit production: remediation END
  resolved_at?: string        // ISO — verified resolved
  resolution_type?: string    // 'code_fix' | 'rollback' | 'config' | 'infra' | 'data' | 'no_action'
}
```

**Spans.** diagnosis = `cause_confirmed_at − acknowledged_at`; remediation =
`fix_deployed_at − cause_confirmed_at`; diagnosis share = diagnosis / (diagnosis + remediation).

## Where the timestamps come from (the messy reality, D10-INSTRUMENT §3)

You won't have a clean export; assemble it from your existing sources:

| Field | Typical source |
|---|---|
| `detected_at` | Sentry `firstSeen` / monitor first-fire / PagerDuty incident `created_at` |
| `acknowledged_at` | PagerDuty/Opsgenie ack, or first responder message in the incident channel |
| `cause_confirmed_at` | first "root cause is…" / "found it" message in the incident channel or ticket status change |
| `fix_deployed_at` | deploy log / CI deploy job finish / the merge-then-deploy of the fixing PR |
| `resolved_at` | incident close / monitor recovery |
| `resolution_type` | postmortem field; **be honest about `rollback`** — it is a fast remediation that teaches nothing about *fix* time |

`cause_confirmed_at` is the field teams least often record — and it is the one that separates
diagnosis from remediation. If most records land in `no_cause_ts`, the tool reports **low
confidence** and the real first task is instrumenting your tracker to stamp it.

## What it handles (and reports, never hides)

- **Excludes** records lacking a decomposable split, by reason: `no_start_ts`, `no_cause_ts`,
  `no_fix_ts`, `nonpositive_span` (timestamps out of order — a data error), `degenerate_zero_total`.
- **Rollbacks** are counted but flagged: a rollback is not a code fix, so it does not inform
  Loop C's reach (attack #1). High rollback / non-code share shrinks the auto-repair tail further.
- **Loop C addressability**: median remediation over `code_fix` incidents only — the slice
  autonomous repair could actually shorten.
- **Confidence**: `low` if the majority of incidents are non-decomposable; `moderate` for small
  samples; `ok` otherwise.

## Output (JSON shape)

`--json` emits `{ verdict, recommendation, confidence, counts, medianDiagnosisShare,
aggregateDiagnosisShare, medianDiagnosisMin, medianRemediationMin, loopCAddressable, classes,
exclusionsByReason }`.

## Adapters — get your data into the contract (`adapters/`)

You rarely have a clean export. The pipeline is: **source adapter → enrich → `analyze`**.

```ts
import { csvToIncidents } from './adapters/csv'
import { pagerDutyToIncidents } from './adapters/pagerduty'
import { enrichWithDeploys, enrichWithGit, parseGitLog } from './adapters/enrich'

// 1. source → contract
const recs = pagerDutyToIncidents(pdExport)          // or csvToIncidents(csvText)
// 2. fill the timestamp trackers lack (fix_deployed_at) from a deploy log or git
const withFix = enrichWithDeploys(recs, deployLog)   // explicit incident→deploy linkage
// or:  enrichWithGit(recs, parseGitLog(gitLogText), id => new RegExp(`\\b${id}\\b`))
// 3. analyze  →  bun run d10.ts <written-json>   (or call analyze() directly)
```

- `adapters/csv.ts` — universal. Maps columns by header with aliases (`created_at`↔`detected_at`,
  `diagnosed_at`↔`cause_confirmed_at`, `deployed_at`↔`fix_deployed_at`, …). Handles quoted commas.
- `adapters/pagerduty.ts` — representative API adapter. Maps detection/ack/resolve; **leaves
  `cause_confirmed_at`/`fix_deployed_at` undefined** because PagerDuty doesn't record them. Opsgenie /
  Linear / ServiceNow follow the same shape — map their native fields here.
- `adapters/linear.ts` — maps Linear issue **state-transition history** → the contract via a
  configurable state-name map (`LINEAR_STATE_*`). If your workflow has a "Root cause found" state,
  Linear knows `cause_confirmed_at`; if not, it stays undefined (honest). Live pull:
  `../connectors/linear-pull.ts`.
- `adapters/sentry.ts` — detection only (`detected_at` + service); lifecycle fields left undefined.
  Live pull: `../connectors/sentry-pull.ts`. Pair with Linear + a deploy log to decompose.
- `adapters/enrich.ts` — `enrichWithDeploys` (earliest explicitly-linked deploy → `fix_deployed_at`,
  no fuzzy time-window guessing) and `enrichWithGit` (earliest commit referencing the incident id).

For the **live** pull (reads credentials from a gitignored `../connectors/.env`, never committed),
see [`../connectors/README.md`](../connectors/README.md).

**The honest lesson the adapters encode:** PagerDuty + a deploy log **still can't decompose** — there's
no `cause_confirmed_at`, so diagnosis can't be separated from remediation. That's not a bug in the
adapter; it's the tool telling you the one timestamp worth adding to your process
(`fixtures/` + `adapters/adapters.test.ts` prove exactly this).

## Files

- `d10.ts` — the instrument (CLI + importable `analyze`/`decompose`/`median`/`label`).
- `fixtures/incidents.sample.json` — synthetic dataset (diagnosis-heavy overall; `payments`
  deliberately remediation-heavy; 3 messy records) so the tool runs and is testable out of the box.
- `d10.test.ts` — unit tests pinning the math, exclusion reasons, and per-class verdicts.
