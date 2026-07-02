# D10 — MTTR Bottleneck Instrument (spec)

> Resolves decision **D10** (STRESS-TEST.md, "Hidden decisions"). The reframe's center of gravity (**D5**: RCA copilot + test-healing) is *conditional* on this measurement. This document specifies a self-serve instrument that tells the operator, from their own historical data, whether their MTTR bottleneck is **diagnosis** or **remediation** — before committing engineering effort to Loop A vs the deferred Loop C.
>
> Directly answers devil's-advocate attack **A1** ("the copilot only wins if diagnosis is a real slice of MTTR — assumed, not measured") and **A6** / STRESS-TEST §9 ("rollbacks teach nothing about a fix; entangled commits; lossy incident→commit linkage; fingerprint drift; no harm metric").

---

## 1. The question, and what it does and does not gate

**The question:** *In our incident history, what fraction of MTTR is spent figuring out what's wrong (diagnosis) versus fixing and shipping it (remediation)?*

The reframe (STRESS-TEST §"What survives") asserts the RCA copilot is "~80% of the value, ~10% of the risk." Attack **A1** is that the 80% is *asserted, not measured* — true only if diagnosis is actually a large slice of the wall-clock an on-call human burns per incident. If most of MTTR is remediation (writing, reviewing, deploying the fix), a diagnosis copilot polishes a step that was never the bottleneck.

**What this instrument gates — and what it does not (answers critique #5):**

- It gates **whether Loop A (RCA copilot) is built *now* or deferred**, and it supplies the earn-later evidence for whether **Loop C (autonomous production repair)** is ever justified per-incident-class.
- It does **not** gate **Loop B (test-suite self-healing)**. Loop B ships first regardless of this number — its blast radius is contained and its trust model (a human reads the test) dodges A1/A3/A6 entirely (LOOP-B-SPEC.md). Do not read a Loop-B recommendation out of this instrument; that would be circular, since Loop B is verdict-independent (see §6).

So the verdict space this instrument actually produces is three-valued, over Loop A / Loop C only:

| Measured split | What it means | Verdict (Loop A / Loop C only) |
|---|---|---|
| **Diagnosis-heavy** | The human spends most of MTTR *understanding* the incident. | **Loop A now.** Its grounded why-trace attacks the dominant slice. A1 defeated with data. |
| **Remediation-heavy** | Diagnosis is fast; *shipping the fix* is slow. | **Loop A deferred.** The data-pointed lever is Loop C — the rare, hard, dangerous tail (STRESS-TEST A1/§1). The cheapest correct move is *no agent loop yet*: fix remediation friction (CI speed, deploy/review latency) with conventional tooling, re-measure. Loop C is earned later, per-class, on outcome data (D6). |
| **Neither dominates / high variance / data too thin** | No single bottleneck, or the join is too lossy to trust (§3, §5). | **Instrument-and-reconsider.** Ship the measurement infra, run a rolling window, decide on real per-class data. Do not build a loop on a coin-flip. |

**Non-negotiable framing:** the instrument is *not* an agent, has *zero* write access, and touches no production system. It is an offline analytics job. It is Tier 0 by construction. It ships **before** any Loop A/C go/no-go, and it is deliberately cheaper than either loop: a read-only, idempotent script over data that already exists.

---

## 2. The decomposition — measurable spans

An incident's lifecycle is four consecutive spans between five timestamps. Diagnosis and remediation are the two middle spans; the outer two are context (they bound MTTA and verification, not the diagnosis-vs-remediation question).

```
 t0 detected      t1 acknowledged   t2 cause-confirmed   t3 fix-deployed    t4 verified-resolved
    │                  │                   │                   │                  │
    ├──── MTTA ───────►├──── DIAGNOSIS ───►├─── REMEDIATION ──►├─── VERIFY ──────►│
    │  detect→ack       │  ack→confirmed     │  confirmed→        │  deployed→        │
    │  (triage lag)     │  cause             │  deployed          │  verified         │
```

| Span | From → To | Name | What it measures | A1-relevance |
|---|---|---|---|---|
| S1 | `t0` → `t1` | **MTTA** | Detection to human ack | Alerting/paging health. Context only. |
| **S2** | `t1` → `t2` | **DIAGNOSIS** | Ack to confirmed root cause | Time the on-call spends understanding *what* is wrong. **Loop A compresses this.** |
| **S3** | `t2` → `t3` | **REMEDIATION** | Confirmed cause to fix deployed | Time to write, review, merge, deploy the fix. **Loop C compresses this.** |
| S4 | `t3` → `t4` | **VERIFY** | Deployed to verified-resolved | Confidence the fix worked (see VERIFICATION-GATE.md). Context only. |

**The bottleneck ratio**, per incident:

```
diagnosis_share  = S2 / (S2 + S3)          # ∈ [0,1]; ignores S1, S4 (neither loop's target)
```

We report the **distribution** of `diagnosis_share`, not just the mean — the mean of a bimodal population lies (see §4 histogram, §5 rule). We also report absolute `S2` and `S3` medians: a large *share* of a tiny absolute time is not worth an agent loop.

**Timestamp definitions (load-bearing — operationalized, not hand-waved):**

| Timestamp | Canonical definition | Primary source |
|---|---|---|
| `t0` detected | First alert/event for the incident's fingerprint | Tracker `created_at` (Sentry/PagerDuty) |
| `t1` acknowledged | A human takes the page / moves to "investigating" | PagerDuty `acknowledged_at`, Linear status→In Progress |
| `t2` cause-confirmed | First human artifact naming the cause | Incident-doc "Root Cause" field first-write, or chat cause-declaration |
| `t3` fix-deployed | The remediating change reaches prod | Deploy-log entry linked to incident, else merge time of linked PR |
| `t4` verified-resolved | Incident closed/resolved by a human | Tracker `resolved_at` |

`t2` is the hardest and most important timestamp — the boundary between the two spans we care about. §3 handles extraction from messy reality and what to do when it is missing.

---

## 3. Data sources — and the messy reality (A6)

Timestamps live in four systems. None was designed to answer this question; the instrument's real work is the **join** and the **honest handling of the cases where the join is lossy or lying**.

| Source | Provides | Extraction |
|---|---|---|
| **Incident tracker** (Sentry / PagerDuty / Linear) | `t0`, `t1`, `t4`, id, fingerprint, severity, incident-class tags, service | REST API export → normalized rows |
| **Git** (GitHub) | Commit/PR timestamps, first commit/PR referencing incident id, diff, files touched | `git log --grep=<id>`, GitHub linked-PR API |
| **Deploy log** | `t3`, deploy id, commit SHA, service, timestamp, deploy type | GitHub Actions deployment API, or deploy-tool audit log |
| **CI log** | Per-run duration, queue time, review-request→merge latency — **keyed to commit/PR, not to incident** | GitHub Actions run API + PR review timeline API |
| **Chat** (Slack/Telegram incident channel) | `t2` candidate messages, participants | Channel history API; keyword+heuristic scan of the incident thread |

The CI log is a first-class source specifically to close critique #1 (see §3.6): it lets us measure remediation friction **without** the lossy incident→commit join.

### A6, head-on: dirty data is handled, not assumed away.

**A6.1 — Rollbacks teach nothing about a fix.** A revert/flag-flip/scale-op is a *mitigation* whose diagnosis was deferred, not done. Counting it as fast S2 would falsely inflate "diagnosis is easy."
- **Handling:** classify each remediation from git-diff + deploy metadata. Revert commit, feature-flag flip, or deploy of a prior SHA → `remediation_type = mitigation`, **excluded from the primary S2/S3 split**, reported in a separate bucket with `t1`→`t_mitigated` timing. A mitigation later followed by a forward-fix is split into two linked records; only the forward-fix enters the split population. *(Same distinction VERIFICATION-GATE.md draws between "reversible" and "proven side-effect-free.")*

**A6.1b — Irreversible forward-fixes (critique #8).** A *forward-fix* whose diff touches a migration has a wholly different S3/reversibility profile and must not be pooled with ordinary code fixes.
- **Handling:** if a `forward-fix` diff touches any path in the protected/irreversible list (`**/migrations/**` and the rest of ARCHITECTURE-ORIGINAL §5 `protected_paths`), tag `remediation_type = forward-fix-irreversible`. Kept in the split-population **share** stats (its S2 is still valid) but **reported separately** for absolute S3 and flagged, because its remediation latency reflects migration/change-management overhead, not diagnosis-vs-fix difficulty.

**A6.2 — Entangled commits.** The fix commit also refactors / bumps deps / fixes an unrelated bug; its size and `t3` lag are not attributable to *this* incident.
- **Handling:** `commit_entanglement = (files touched outside incident's affected_paths) / (total files touched)`. If `> 0.5` → `dirty_link = entangled`: **excluded from absolute-time stats** (S3 untrustworthy) but **kept in share stats** if `t3` is otherwise well-linked — degrade gracefully rather than drop. Never silently attribute an entangled commit's full latency to remediation.

**A6.3 — Lossy incident→commit linkage (the biggest coverage killer).** Many incidents carry no id in any commit; the human never linked them.
- **Handling:** three-tier join with explicit confidence, never a silent guess:
  1. **Explicit** (`link_confidence = high`): commit/PR message contains the id, or the tracker has a linked-PR field. Direct join.
  2. **Heuristic** (`link_confidence = medium`): no explicit id, but a deploy on the incident's service touching `affected_paths` lands in `[t2, t2 + 24h]`. Join with a flag.
  3. **Unlinked** (`link_confidence = none`): no candidate. `t3 = null`; contributes to **S1/S2 stats only**; counted in `unlinked_rate`.
- The instrument **reports the linkage-confidence mix** as a first-class output. Critically, medium links are **provisional evidence for magnitude, never trust** (see §5 Gate 0 and critique #4).

**A6.4 — `t2` is soft.** Chat is freeform; there may be no cause-declaration, or several false ones. Every incident carries `t2_source ∈ {incident_doc_field, chat_phrase, pr_opened_proxy, missing}`, resolved by ranked heuristic:
  1. Incident-doc "Root Cause" field first-write timestamp (most reliable).
  2. Else first chat message matching a cause-declaration pattern (`root cause`, `caused by`, `it's the`, `found it`, `the bug is`), authored by a responder, in the incident thread.
  3. Else `t2 ≈ first-commit-on-fix-branch` (`t2_source = pr_opened_proxy`).
  4. Else `t2 = missing`: contributes to MTTA / total-MTTR only, excluded from the split.

  **On the `pr_opened_proxy` (fixes critique #3).** The prior claim that this proxy "biases against Loop A, so a diagnosis-heavy verdict is robust" is **wrong and is dropped.** Incidents needing the proxy are a *biased subset* — the messy, hard-to-diagnose ones with no crisp root-cause artifact. Pushing `t2` to when coding starts *shrinks* their measured S2, biasing them *toward* remediation-heavy — exactly backwards for the sub-population that matters most to A1. Therefore `pr_opened_proxy` incidents are **excluded from the primary split** and reported as a **labeled sensitivity band** (`split-histogram` overlays "primary" vs "primary + proxy") so a reader sees how far the verdict could move if the proxy were trusted. No directional-robustness claim is made.

**A6.4-LLM — optional `--llm-assist` for `chat_phrase` disambiguation is untrusted-text-into-a-model (closes critique #2 / D7 / attack #7).** When enabled, the LLM pass is used **only** to disambiguate step-2 chat candidates. It is hardened as an untrusted-input boundary, because chat/incident text is attacker-influenceable (D7 treats all telemetry text as untrusted — a read-only tool does not exempt it):
  - **Tool-less.** The classifier model has **no tools** — no code-search, no git, no exec. There is no tool-use chain to hijack; the worst a poisoned log line can do is mislabel one `t2`.
  - **Untrusted framing.** Chat text is passed inside a data envelope, explicitly marked untrusted, truncated to the candidate line ± small context; no instructions from chat content are honored.
  - **Enum-validated output.** The only accepted output is one label from a fixed enum (`{cause_declaration | not_cause | ambiguous}`) plus the matched line's timestamp. Free-form output is rejected; a non-enum response falls back to the deterministic keyword rule.
  - **No hot-path role.** LLM-assist never touches S2/S3 arithmetic, the join, or the verdict — only which chat line is picked as `t2` when the deterministic rule found several.

**A6.5 — Fingerprint drift** (STRESS-TEST §9) splits one logical incident across two tracker records after a refactor.
- **Handling:** dedup by `(service, affected_paths overlap, time-adjacency < 1h)` before span computation; every merge is logged to the audit trail.

**Cross-cutting replayability (fixes critique #10).** Every derived timestamp, exclusion, and linkage decision is written to an **immutable per-incident audit record**. Replay guarantee: *given the same raw exports and the same cached label set, the instrument produces the same split and the same exclusion list.* For `--llm-assist` runs, determinism is preserved by pinning `model` + `temperature=0` **and caching each label into `audit.jsonl`** — replay reads the cached label, never a fresh LLM call. A run with no cache and no `--llm-assist` is deterministic by construction.

### 3.6 Remediation-friction proxy — a linkage-independent view (fixes critique #1)

`diagnosis_share` alone **structurally under-samples the remediation-heavy world**: incidents whose remediation is slow for CI/deploy/review reasons are disproportionately the `link_confidence=none` incidents dropped from the split, biasing the surviving population toward well-linked, fast-remediation (i.e. diagnosis-heavy) incidents. The split gate could therefore never *see* the world it exists to detect.

So the instrument computes, from the **CI + deploy logs directly and independently of any incident join**, over the same window and services:

```
ci_median_run_min        # median CI pipeline duration per successful run
review_median_latency_min# median review-request → merge for merged PRs
deploy_median_lag_min     # median merge → prod-deploy
remediation_floor_min     # ci_median_run + review_median_latency + deploy_median_lag
```

`remediation_floor_min` is a **lower bound on S3 that every incident pays regardless of linkage** — it is the mechanical cost of shipping *any* change through this org's pipeline. If `remediation_floor_min` is large (e.g. ≥ the org's median S2), the remediation-heavy verdict has an evidence source that **does not depend on the lossy join at all**, and §5 uses it as an independent confirmer of a remediation-heavy call (see Gate 1). This is the honest answer to "the metric can't see the world it gates."

---

## 4. The runnable instrument

A single offline TS script (stack-consistent with Claude Agent SDK tooling, but **no LLM in the hot path** — deterministic analytics; the optional LLM pass is confined to §3 A6.4-LLM and gated behind `--llm-assist`). Reads exports, writes a report. No prod access, no write access, idempotent.

### Interface

```
mttr-bottleneck \
  --incidents   ./exports/incidents.json     # tracker export (t0,t1,t4,fingerprint,severity,class,service)
  --git-repo    ./repo                        # or --git-log ./exports/gitlog.json
  --deploys     ./exports/deploys.json        # deploy log (t3, sha, service, ts, type)
  --ci          ./exports/ci.json             # CI runs + PR review timeline (for remediation_floor, §3.6)
  --chat        ./exports/chat.json           # incident-channel messages (for t2)
  --severity-map ./config/severity-map.yaml   # tracker severity field → SEV ordinal (see below)
  --window      last-90d                       # rolling verdict window; or explicit ISO range
  --min-severity SEV3                          # exclude noise below this (ordinal, per severity-map)
  [--llm-assist  --llm-model <pinned> ]        # optional: tool-less t2 disambiguation only (§3 A6.4-LLM)
  --out         ./report/
```

**Severity normalization (fixes critique #9).** Tracker severity is a raw field (ARCHITECTURE-ORIGINAL §2 "raw score"), not an ordinal. `--min-severity` compares against a **required** `severity-map.yaml` that maps each tracker's native severity into a fixed ordinal; `≥` is defined on the ordinal only. No mapping → hard error, never a silent string comparison.

```yaml
# severity-map.yaml — one block per source system
sev_ordinal: [SEV1, SEV2, SEV3, SEV4, SEV5]     # SEV1 highest
sources:
  pagerduty:  { P1: SEV1, P2: SEV2, P3: SEV3, P4: SEV4 }
  sentry:     { fatal: SEV1, error: SEV2, warning: SEV4 }
  linear:     { Urgent: SEV1, High: SEV2, Medium: SEV3, Low: SEV4 }
```

### Types (the contract)

```ts
type IncidentClass = 'backend-code' | 'frontend-code' | 'config' | 'data'
  | 'capacity' | 'upstream-dependency' | 'infra' | 'unknown';

type RemediationType = 'forward-fix' | 'forward-fix-irreversible'
  | 'mitigation' /* revert/flag/scale */ | 'none';
type LinkConfidence  = 'high' | 'medium' | 'none';
type T2Source        = 'incident_doc_field' | 'chat_phrase' | 'pr_opened_proxy' | 'missing';

interface IncidentRecord {
  id: string;
  service: string;
  incidentClass: IncidentClass;           // from tracker tags; 'unknown' if untagged
  severityOrdinal: 'SEV1'|'SEV2'|'SEV3'|'SEV4'|'SEV5';   // normalized via severity-map
  t0_detected: string;                    // ISO; always present
  t1_ack:       string | null;
  t2_confirmed: string | null;  t2Source: T2Source;
  t3_deployed:  string | null;  linkConfidence: LinkConfidence; remediationType: RemediationType;
  t4_resolved:  string | null;
  // derived spans (null if a boundary is missing)
  s1_mtta_min:        number | null;
  s2_diagnosis_min:   number | null;
  s3_remediation_min: number | null;
  s4_verify_min:      number | null;
  diagnosisShare:     number | null;      // s2/(s2+s3)
  // data-quality flags — first-class, never hidden
  dirtyLink: null | 'entangled' | 'heuristic-window';
  commitEntanglement: number | null;      // 0..1
  excludedFromSplit: boolean;
  exclusionReason: string | null;         // 'mitigation' | 't2_missing' | 't3_unlinked'
                                           //  | 't2_pr_proxy' | 'entangled-abs-only'
}
```

### Join logic (deterministic core)

```
for each incident I in window with severityOrdinal ≥ min-severity:
  1. base   ← tracker row → t0, t1, t4, class, severity, service, fingerprint
  2. dedup  ← merge fingerprint-drift siblings (§3 A6.5)
  3. t2     ← ranked heuristic (§3 A6.4) → set t2, t2Source
              (chat_phrase disambiguation via §3 A6.4-LLM only if --llm-assist; cache label)
  4. link fix:
       candidates ← git commits/PRs referencing I.id                         (link=high)
                  ∪ deploys on I.service touching affected_paths in [t2, t2+24h]  (link=medium)
       if none    → link=none, t3=null
       else       → t3 = earliest linked deploy ts; classify remediationType from diff/deploy
                    entanglement ← off-path-files / total-files
                    if remediationType=mitigation                → excludedFromSplit=true ('mitigation')
                    if diff touches protected/irreversible paths → remediationType='forward-fix-irreversible'
                    if entanglement>0.5                          → dirtyLink='entangled' (abs-time excluded)
  5. spans  ← compute S1..S4 from available timestamps; null-safe
  6. eligibility for SPLIT population:
       excludedFromSplit = (t2==null)
                        || (t3==null)
                        || (remediationType=='mitigation')
                        || (t2Source=='pr_opened_proxy')     // §3 A6.4 — sensitivity band, not primary
  7. write IncidentRecord (+ audit trail of every decision in 3–6)

separately (no incident join):  compute remediation_floor_min from --ci + --deploys  (§3.6)
```

### Outputs

1. **`split-histogram.svg/json`** — distribution of `diagnosisShare` over the **primary** eligible population, bucketed `[0–0.1 … 0.9–1.0]`; bimodality is visible where a mean would hide it. Overlays: (a) median `S2`/`S3` in absolute minutes; (b) a **sensitivity band** re-including `pr_opened_proxy` incidents so the reader sees the verdict's fragility to the soft-`t2` subset.
2. **`by-class.json`** — the split **per `IncidentClass`**, each with its own data-quality block (see §5 per-class gate). The sharpest A1 output: it may show *backend-code* incidents are diagnosis-heavy (Loop A wins there) while *config*/*capacity* are remediation-heavy (no loop helps — matches STRESS-TEST §1 that most incidents are classes the repair workers can't touch). The decision is *per-class*, echoing Loop C's per-incident-class trust expansion (see LOOP-C-DEFERRED.md).
3. **`remediation-friction.json`** — `ci_median_run_min`, `review_median_latency_min`, `deploy_median_lag_min`, `remediation_floor_min` (§3.6). Linkage-independent; the second evidence leg for a remediation-heavy call.
4. **`data-quality.json`** — `eligible_N`, `unlinked_rate` (**computed on `link_confidence=high` only**, see §5/#4), `medium_link_share`, `high_link_share`, `t2_missing_rate`, `pr_proxy_rate`, `mitigation_rate`, `entangled_rate`, `t2_source` mix — **aggregate and per-class**. The A6 firewall data.
5. **`recommendation.md`** — applies §5's rule; prints the verdict + the evidence + which independent leg (split and/or friction proxy) supports it + the sensitivity band.
6. **`audit.jsonl`** — immutable per-incident decision log (every span, exclusion, linkage confidence, cached LLM label). Replayable.

---

## 5. Decision rule

Applied by `recommendation.md`. Two gates run **in order**: **Gate 0 — data quality** (A6 firewall) first, then **Gate 1 — the split** (A1 answer). A Loop-A/Loop-C verdict is emitted only if Gate 0 passes; otherwise the verdict *is* "instrument-and-reconsider."

**Config (defaults; tune per org):**
```yaml
decision:
  window:                    last-90d      # rolling; eligible_N must be met WITHIN the window (#11)
  min_eligible_incidents:    30            # below this, no statistically meaningful verdict
  data_quality_floor:                      # applied at aggregate AND per-class (#7)
    max_unlinked_rate:       0.40          # unlinked_rate is over link=HIGH only (#4)
    max_t2_missing_rate:     0.40
    min_high_link_share:     0.30          # medium links NEVER count toward clearing this (#4)
    max_pr_proxy_rate:       0.30          # too many soft-t2 → verdict is band, not point
  split:
    diagnosis_heavy_share:   0.60          # median diagnosisShare ≥ 0.60 → diagnosis dominates
    remediation_heavy_share: 0.40          # median diagnosisShare ≤ 0.40 → remediation dominates
    min_abs_diagnosis_min:   15            # a large SHARE of <15min median S2 isn't worth a loop
```

**Gate 0 — data quality (A6 firewall).** Verdict = "instrument-and-reconsider" if **any** holds:
- `eligible_N < min_eligible_incidents` **within the rolling window** (not cumulative — fixes #11);
- `unlinked_rate > max_unlinked_rate`, where `unlinked_rate` counts only incidents that failed to achieve **`link_confidence=high`** — medium heuristic links do **not** reduce it (fixes #4: the `[t2,t2+24h]` heuristic cannot manufacture a pass, since those are the exact entangled/wrong-attribution links A6.2 warns about);
- `high_link_share < min_high_link_share`;
- `t2_missing_rate > max_t2_missing_rate`;
- `pr_proxy_rate > max_pr_proxy_rate` (verdict may still be emitted but is reported as a **band, not a point**).

On any breach: ship the measurement infra (§6 shows most is needed regardless), enforce incident-id in PR titles to raise **future** `high_link_share`, run another rolling window. **Do not build Loop A or earn Loop C on data this thin.**

**Gate 1 — the split (answers A1).** On data passing Gate 0, using the **median** `diagnosisShare` over the **primary** eligible population (proxy incidents excluded, §3 A6.4) *and* absolute S2 magnitude *and* the independent friction proxy (§3.6):

| Condition | Verdict | Rationale |
|---|---|---|
| `median diagnosisShare ≥ 0.60` **and** `median S2 ≥ 15min` | **Loop A now.** | Diagnosis is the real, large slice. The RCA copilot attacks the bottleneck. A1 defeated with data. Proceed per ARCHITECTURE-REFRAMED.md. |
| `median diagnosisShare ≤ 0.40` **and** `remediation_floor_min ≥ median S2` | **Loop A deferred; fix remediation friction first.** | Diagnosis is *not* the bottleneck, and the **linkage-independent** friction proxy confirms shipping cost is real — so the conclusion does not rest on the biased split population (#1). The data-pointed lever is Loop C, the hard/dangerous tail (STRESS-TEST A1/§1): earn it only later, per-class, on outcome data (D6). Meanwhile attack CI/deploy/review latency with conventional tooling and re-measure. |
| `median diagnosisShare ≤ 0.40` **but** `remediation_floor_min < median S2` | **Instrument-and-reconsider.** | The split says remediation-heavy but the independent friction proxy does *not* corroborate — likely the split population is biased by dropped unlinked incidents (#1). Two legs disagree; do not commit. |
| `0.40 < median < 0.60`, or bimodal, or `median S2 < 15min` | **Instrument-and-reconsider.** | No dominant bottleneck, or absolute diagnosis time too small to justify an agent. Decide per-class from `by-class.json`. |

**Per-class override (fixes critique #7).** Even under an aggregate "instrument-and-reconsider," a single `IncidentClass` earns **Loop A scoped to that class** only if it independently satisfies **all** of: `≥ min_eligible_incidents` samples *in that class*, `diagnosisShare ≥ 0.60`, `S2 ≥ 15min`, **and its own per-class data-quality floors** (`unlinked_rate`/`high_link_share`/`t2_missing_rate` computed within the class, not borrowed from the aggregate). A thin class with garbage linkage cannot green-light itself. This is the correct-granularity decision — the reframe never claimed diagnosis dominates *everywhere*, only that where it does, the copilot is the cheap win.

**Scope reminder (fixes critique #5).** This gate decides **only** Loop A-now vs Loop A-deferred, and supplies Loop C's per-class earn-later evidence. It does **not** emit a Loop-B verdict. Loop B (LOOP-B-SPEC.md) is built first regardless (see §6).

---

## 6. Robust-to-both design — what you build regardless of the verdict

Measuring first is *not* freezing all work until the number lands. Most of the reframed architecture is a prerequisite for **both** the diagnosis branch and the remediation branch, so the team builds it in parallel with the rolling measurement window and is never idle.

| Component | Needed if diagnosis-heavy (Loop A) | Needed if remediation-heavy (Loop C) | Verdict-independent? |
|---|---|---|---|
| **Signal layer** (ARCHITECTURE-ORIGINAL §2) — normalized `Incident Candidate`, deploy-event ingestion, signed/authenticated ingestion (D7) | Yes — copilot's input | Yes — auto-repair's trigger | **Build now.** Also *is* a source that improves this instrument's `t0`/fingerprint next run. |
| **Aggregation & dedup** (§3) — fingerprinting, noise suppression | Yes | Yes | **Build now.** Directly fixes A6.5 fingerprint-drift here. |
| **Incident Memory** (Postgres + pgvector, D1; outcome-weighted per STRESS-TEST §8) | Yes — grounded similar-incident context | Yes — outcome-weighted priors | **Build now.** This instrument's `audit.jsonl` is the seed corpus. |
| **Verification gate** (mutation score D4, must-fail-on-parent D4, judge-by-signals D8) — VERIFICATION-GATE.md | Weakly (copilot doesn't write code) | Yes — grounded-confidence source for auto-apply (D2/D3) | **Build now** for Loop B (LOOP-B-SPEC.md needs the same mutation/must-fail gate); reused by Loop C later. |
| **Durable orchestration** (AgenticOps Postgres state machine, D1) | Yes — holds incident state across async HITL wait | Yes | **Build now.** No new runtime (D1). |
| **HITL Telegram bot + why-trace / kill switch / immutable audit log** (cross-cutting) | Yes — hands the trace to on-call | Yes — approval + accountability owner (D9) | **Build now.** |
| **Loop B — test-suite self-healing** (LOOP-B-SPEC.md) | Safe parallel track | Safe parallel track | **Build now** — verdict-independent; contained blast radius; dodges A1/A3/A6. |
| **RCA agent write-path to app code** | No (Tier 1, zero write access — the v1 product) | Loop C only, deferred | **Never for Loop A. Deferred for Loop C** — the *only* capability that genuinely waits on the verdict. |

**Reading:** the only truly *contingent* capability is autonomous **write access to production code** (Loop C). Everything upstream of a write — signal, dedup, memory, verification, orchestration, HITL, audit — and Loop B serve both branches and should be under construction while the instrument runs. The measured split decides only whether **Loop A rides now** or **Loop C is ever earned** (per-class, on outcome data, D6).

**On "no metric for harm caused" (STRESS-TEST §9).** This instrument measures *where the bottleneck is*, not *whether an auto-fix caused harm* — the harm metric (incidents caused/worsened by an auto-applied fix; recurrence in the touched file) lives in the outcome-based trust controller (D6, see VERIFICATION-GATE.md / trust-expansion spec). But this instrument seeds it: `audit.jsonl` + Incident Memory give the baseline recurrence/spawn data the harm metric later diffs against. A confounded before/after MTTR (§9) is precisely why the verdict rests on the *within-window split distribution and the independent friction proxy*, not on an aggregate MTTR trend.

**Closing the loop on A1 and A6:**
- **A1** is answered by `split-histogram.json` + `by-class.json` + `remediation-friction.json`: the 80%-of-value claim is now a measured, per-class number with a decision rule attached, a linkage-independent second leg that keeps the remediation-heavy world visible, and a documented deferral path when the claim is false.
- **A6** is answered by making dirty data *fail loud, not silent*: mitigations quarantined, irreversible forward-fixes tagged, entangled commits excluded from absolute-time stats, soft-`t2` proxies pushed to a sensitivity band, lossy links tiered by confidence with the unlinked floor computed on high-confidence links only, and the whole verdict gated behind a data-quality floor (aggregate and per-class) that downgrades to "instrument-and-reconsider" rather than manufacturing a confident conclusion from a hole.

---

**Deliverables of this component:** the `mttr-bottleneck` script (§4), its config + `severity-map.yaml` (§4–§5), and a one-page runbook for exporting the five data sources. It is Tier 0 by construction — read-only, offline, no agent, no write path — and it is the first thing built, because it is the thing that tells you whether the rest of the reframe is pointed at the right target.

---

Files referenced (all absolute): `/Users/duchenchuk/Desktop/Self-healing code/ARCHITECTURE-ORIGINAL.md`, `/Users/duchenchuk/Desktop/Self-healing code/STRESS-TEST.md`, `/Users/duchenchuk/Desktop/Self-healing code/LOOP-B-SPEC.md`. The document body above is the final `D10-INSTRUMENT.md`. Every valid BLOCKER/MAJOR/MINOR from the critique is resolved: #1 (linkage-independent remediation-friction proxy + two-leg split gate), #2 (tool-less/enum-validated/untrusted-framed LLM-assist per D7), #3 (pr_opened_proxy moved to sensitivity band, backwards robustness claim dropped), #4 (unlinked_rate on high-confidence links only; medium never clears the floor), #5 (gate scoped to Loop A-now/deferred + Loop C earn-later; Loop B declared verdict-independent, removed from the split verdict column), #7 (per-class data-quality floors), #8 (`forward-fix-irreversible` tag on migration-touching diffs), #9 (required `severity-map.yaml` ordinal normalization), #10 (pinned model + cached labels for replay), #11 (rolling `last-90d` window reconciled, eligible_N within-window). Critique #6 (nonexistent attack #11) needs no body change — confirmed STRESS-TEST contains only attacks #1–#9.
