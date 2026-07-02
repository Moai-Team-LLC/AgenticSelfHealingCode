# Incident Memory (spec)

> **Reconciliation note.** `ARCHITECTURE-REFRAMED.md` is the source of truth for cross-component
> contracts and overrides this file where they differ. Superseded here:
> `autoActionId` → canonical **`actionId`** (`OutcomeEvent = {actionId, kind, at}`, keystone §3.2);
> `W_confirm` is **deleted** — maturation defers to `W_mature = 30d` (keystone §3.5);
> `resolutions.auto_action_id` is set for **both** `machine` and `human_approved` landings (**not NULL**
> for human-merged PRs), and the `auto_action` row is written by `ORCHESTRATION.md`'s apply-time writer,
> not the gate (keystone §3.2); the label enum gains `provisional_human_confirmed` (keystone §3.6).
>
> **Round-2 obligations (from `ORCHESTRATION.md` / `HITL-APPROVAL.md` finalization):** `auto_action` lives in
> schema **`orch`** (`orch.auto_action.action_id`) — this file's `trust.auto_action.id` soft-FKs are superseded.
> `resolutions.status` is the orchestrator's **coarse projection** (`VERIFYING`/`LANDED`→`diagnosed`,
> `OUTCOME_WATCH`→`resolved`). This spec **persists** `provisional_human_confirmed` onto `resolutions` when the
> HITL layer emits the human-verdict event (`HITL-APPROVAL.md` addendum #4); HITL never writes the label itself.

The why-trace store. Reuses AgenticMind's Postgres + pgvector (D1) — same replayable
why-trace principle, same re-embed-to-1536 convention, applied to operational incidents
instead of cited answers. It serves two masters that must not be conflated: it is the
**immutable audit substrate** (every incident replayable end-to-end) AND the **working
retrieval context** the RCA agent reads at triage time. This split is why naive
similarity search is wrong here — retrieval must be outcome-aware (§4), and audit must
never be mutable.

It is also the **outcome projector** for the Trust Controller (§7): it does not itself
decide autonomy, it detects the world's verdict on past auto-actions (recurrence, spawn,
revert, maturation) and emits those as `OutcomeEvent`s in the controller's exact contract.
The controller owns the `auto_action` table and the attribution windows; Incident Memory
*references* that table and *produces* events for it — it never redefines the controller's
schema (see TRUST-CONTROLLER.md §2.2, its `auto_action` DDL, and its `OutcomeEvent` type).

Consumers:
- **RCA agent** — retrieval (§4/§8) via the `memory.retrieve` tool contracted in
  LOOP-A-SPEC.md §6; writes the pending outcome label at trace close (LOOP-A-SPEC.md §3 step 6).
- **Trust Controller** — consumes the `OutcomeEvent` stream this component emits (§7,
  TRUST-CONTROLLER.md `ingestOutcome`, idempotent on `auto_action_id`).
- **Verification Gate** — writes the `GateResult` onto the fix/verification trace steps and
  the `resolutions` row (see VERIFICATION-GATE.md "Produces").
- **HITL bot** — renders "similar past incidents + their outcome" (LOOP-A-SPEC.md §7).

---

## 1. Purpose

1. **Replayable why-trace, not a log.** Each incident is stored as an ordered, typed
   path — `signal → dedup → RCA → resolution path → fix → verification → outcome →
   human_feedback` — with the exact model inputs/outputs, tool calls, and grounded booleans
   (did the repro reproduce? did the fix flip green? — D2/D3) at each hop. Any incident can
   be replayed and judged post-hoc. This is the immutable audit substrate the whole system
   leans on (ARCHITECTURE-ORIGINAL §0 principle 3, §12).

2. **Working retrieval context for the RCA agent.** At triage the agent pulls similar
   past incidents as grounded exemplars: *"we saw this in March; here is the RCA, the fix,
   and — critically — whether it held."* This stops the fleet from re-deriving a known root
   cause from scratch. Post-reframe it is a Loop A / Tier 1 read-only feature: retrieval
   never writes app code, it only informs the human-facing why-trace.

The two purposes have opposite mutability rules: the trace is **append-only and frozen**;
the retrieval layer is **outcome-labeled and re-weighted over time**. We satisfy both by
keeping raw trace rows immutable and layering outcome/embedding state in adjacent tables
that reference — never rewrite — them.

**A note on label vocabularies.** Two consumers read outcome state through *different*
lenses and this component reconciles them from one source of truth (§5.4):

- **Loop A retrieval** reads a *retrieval polarity* label per resolution:
  `confirmed_good | recurred | reverted | wrong_rca | superseded | pending`
  (LOOP-A-SPEC.md §6). This drives exemplar-vs-anti-pattern.
- **Trust Controller** reads a per-auto-action *verdict* through the `OutcomeEvent` enum:
  `applied | recurrence | spawn | spawn_contested | revert | matured`
  (TRUST-CONTROLLER.md §2.2). This drives autonomy.

These are not the same enum and must not be conflated. The `resolutions.outcome_label`
(retrieval-facing) and the emitted `OutcomeEvent.kind` (controller-facing) are both derived
from the same underlying detected facts by the projector (§5.4). Keeping them explicitly
separate is what stops the draft-era silent contract break against both consumers.

---

## 2. Schema (Postgres DDL)

Assumes `pgvector >= 0.7` (HNSW available). Schema `incident_memory`. All timestamps
`timestamptz`. Trace rows are append-only — enforced by trigger *and* by role separation
(§9), not by convention.

> **Ownership boundary.** `incident_memory.*` is defined here. `trust_class`,
> `auto_action`, and `trust_transition` are defined in TRUST-CONTROLLER.md and are **not**
> redeclared here — this component only holds a foreign-key-style reference
> (`auto_action_id uuid`) to `auto_action.id` and emits events against it. The reference is
> soft (no cross-schema FK constraint, because the controller may run its own migration
> cadence); referential integrity is asserted by the projector (§7) at emit time.

```sql
CREATE SCHEMA IF NOT EXISTS incident_memory;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- fuzzy message-template fallback, §6

-- ── incidents ──────────────────────────────────────────────────────────────
-- One row per deduped incident (not per raw signal). Fingerprint columns are the
-- retrieval keys; the brittle stack-hash, the drift-resistant semantic key, the
-- rename-proof symptom signature, and the module_area (§6) are all stored so recall AND
-- recurrence detection survive refactors.
CREATE TABLE incident_memory.incidents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  source            text NOT NULL,                 -- sentry | otel | rum | business-metric
  severity_raw      numeric NOT NULL,              -- raw score from IncidentCandidate (ARCH §2)
  affected_service  text NOT NULL,
  affected_paths    text[] NOT NULL DEFAULT '{}',  -- repo-relative paths; MAY be empty (§10)
  module_area       text NOT NULL,                 -- repo dir at fixed depth (default 2), §6/§10.
                                                    -- ALWAYS populated; falls back from service
                                                    -- when affected_paths is empty. Drift-stable
                                                    -- key shared with the controller's class_key.
  recent_deploys    jsonb NOT NULL DEFAULT '[]',   -- [{deploy_id, ts, diff_url}] (ARCH §2)

  -- Fingerprints (§6). stack_fingerprint = exact/brittle; semantic = drift-resistant but
  -- breaks on symbol rename; symptom_signature = rename-proof, used for recurrence (§7).
  stack_fingerprint     text,                      -- hash(normalized top-N frames)
  semantic_fingerprint  text NOT NULL,             -- hash(error_class + surviving symbols + msg_shape)
  symptom_signature     text NOT NULL,             -- hash(error_class + msg_shape) — no symbols/paths
  fingerprint_lineage   text[] NOT NULL DEFAULT '{}', -- prior fingerprints across refactors
                                                    -- (LOOP-A-SPEC.md §2; git log --follow at dedup)
  error_class           text,                      -- e.g. TypeError, 5xx, timeout
  normalized_message    text NOT NULL,             -- PII/id-stripped signal text, §3

  first_seen        timestamptz NOT NULL,
  occurrences       integer NOT NULL DEFAULT 1,
  status            text NOT NULL DEFAULT 'open'    -- open | diagnosed | resolved | closed
);
CREATE INDEX ix_incidents_stack_fp    ON incident_memory.incidents (stack_fingerprint);
CREATE INDEX ix_incidents_semantic_fp ON incident_memory.incidents (semantic_fingerprint);
CREATE INDEX ix_incidents_symptom_sig ON incident_memory.incidents (symptom_signature);
CREATE INDEX ix_incidents_area        ON incident_memory.incidents (module_area);
CREATE INDEX ix_incidents_service     ON incident_memory.incidents (affected_service);
CREATE INDEX ix_incidents_paths_gin   ON incident_memory.incidents USING gin (affected_paths);
CREATE INDEX ix_incidents_lineage_gin ON incident_memory.incidents USING gin (fingerprint_lineage);
CREATE INDEX ix_incidents_msg_trgm    ON incident_memory.incidents USING gin (normalized_message gin_trgm_ops);

-- ── why_traces ─────────────────────────────────────────────────────────────
-- The replayable path. APPEND-ONLY. One row per hop; ordered by seq. step_type is the
-- typed stage; payload holds the exact model IO / tool call / grounded booleans.
CREATE TABLE incident_memory.why_traces (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id   uuid NOT NULL REFERENCES incident_memory.incidents(id),
  seq           integer NOT NULL,               -- 0-based order within incident
  step_type     text NOT NULL,                  -- signal | dedup | rca | resolution_path
                                                 -- | fix | verification | outcome | human_feedback
  actor         text NOT NULL,                  -- agent name | 'human:<id>' | 'ci' | 'system'
  created_at    timestamptz NOT NULL DEFAULT now(),

  -- Grounded booleans (D3) — NULL if not applicable at this step. These, not any
  -- self-reported LLM confidence, are what downstream trusts.
  repro_reproduced_signal  boolean,             -- D2: sandbox repro reproduced the signal
  fix_flipped_green        boolean,             -- D3: fix turned the repro green
  regression_failed_parent boolean,             -- D4: regression test failed on parent commit

  -- Provenance / injection defense (§3, §8, D7). 'untrusted' marks any step whose payload
  -- embeds attacker-reachable telemetry text (log/trace/error content).
  trust         text NOT NULL DEFAULT 'trusted', -- trusted | untrusted
  payload       jsonb NOT NULL,                 -- {model, prompt_ref, output, tool_calls[],
                                                 --  hypothesis, confidence_selfreport (stored,
                                                 --  NEVER used for gating — D3), diff_ref, ...}
  UNIQUE (incident_id, seq)
);
CREATE INDEX ix_traces_incident ON incident_memory.why_traces (incident_id, seq);
CREATE INDEX ix_traces_steptype ON incident_memory.why_traces (step_type);

-- ── resolutions ────────────────────────────────────────────────────────────
-- The proposed/applied fix (or diagnosis) for an incident + its retrieval-facing outcome
-- label (§5). This is the unit retrieval scores as exemplar-or-anti-pattern. outcome_label
-- is MUTABLE (it matures over time); the underlying trace is not. A single incident MAY
-- have MULTIPLE resolutions over its life (a re-fix supersedes the prior); §4 dedups to the
-- current non-superseded one.
CREATE TABLE incident_memory.resolutions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id    uuid NOT NULL REFERENCES incident_memory.incidents(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  loop           text NOT NULL,                 -- A_rca | B_flaky | B_heal | C_repair
  fix_class      text NOT NULL,                 -- code | config | infra | data | test-heal | rca-only
  diff_ref       text,                          -- PR url / commit sha ; NULL for rca-only (Loop A)
  diff_lines     integer,
  merged_by      text,                          -- human id | 'auto' | NULL ; accountability owner (D9)
  mutation_score numeric,                       -- D4/S5: mutation score on touched module, NULL if n/a
  auto_action_id uuid,                           -- soft FK to trust.auto_action.id.
                                                 -- Set IFF auto-applied (Loop B quarantine or an
                                                 -- eventual Loop C merge). NULL for rca-only and
                                                 -- human-merged PRs.

  -- Retrieval-facing outcome label (§5). Retrieval polarity derives from this — NOT from
  -- "was it green". Distinct from the controller's OutcomeEvent enum (see §1, §5.4).
  outcome_label  text NOT NULL DEFAULT 'proposed',
  outcome_at     timestamptz,                   -- when it reached its current label
  recurrence_incident_id uuid REFERENCES incident_memory.incidents(id), -- set if it recurred
  superseded_by  uuid REFERENCES incident_memory.resolutions(id),       -- set when replaced by a re-fix
  CONSTRAINT ck_outcome_label CHECK (outcome_label IN
    ('proposed','applied','confirmed_good','recurred','reverted','wrong_rca','superseded'))
);
CREATE INDEX ix_resolutions_incident ON incident_memory.resolutions (incident_id);
CREATE INDEX ix_resolutions_outcome  ON incident_memory.resolutions (outcome_label);
CREATE INDEX ix_resolutions_autoact  ON incident_memory.resolutions (auto_action_id);

-- Freeze accountability + provenance once set (D9): merged_by, diff_ref, auto_action_id
-- must not be silently rewritten after assignment. outcome_label / outcome_at /
-- superseded_by / recurrence_incident_id / updated_at remain mutable (that IS the lifecycle).
CREATE OR REPLACE FUNCTION incident_memory.freeze_resolution_provenance()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.merged_by      IS NOT NULL AND NEW.merged_by      IS DISTINCT FROM OLD.merged_by
     THEN RAISE EXCEPTION 'resolutions.merged_by is frozen once set (D9 accountability)'; END IF;
  IF OLD.diff_ref       IS NOT NULL AND NEW.diff_ref       IS DISTINCT FROM OLD.diff_ref
     THEN RAISE EXCEPTION 'resolutions.diff_ref is frozen once set'; END IF;
  IF OLD.auto_action_id IS NOT NULL AND NEW.auto_action_id IS DISTINCT FROM OLD.auto_action_id
     THEN RAISE EXCEPTION 'resolutions.auto_action_id is frozen once set'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_resolutions_freeze
  BEFORE UPDATE ON incident_memory.resolutions
  FOR EACH ROW EXECUTE FUNCTION incident_memory.freeze_resolution_provenance();

-- ── embeddings ─────────────────────────────────────────────────────────────
-- pgvector store. 1536-dim (AgenticMind convention, §3). One row per embeddable object;
-- owner_kind/owner_id is a soft polymorphic ref. We embed the incident signal, the RCA
-- hypothesis, and the resolution rationale separately (§3).
CREATE TABLE incident_memory.embeddings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_kind    text NOT NULL,                  -- 'incident' | 'resolution'
  owner_id      uuid NOT NULL,
  embed_kind    text NOT NULL,                  -- 'signal' | 'rca_hypothesis' | 'resolution_rationale'
  model         text NOT NULL,                  -- 'text-embedding-3-small' (native 1536)
  dims          smallint NOT NULL DEFAULT 1536, -- native dim actually stored (§3)
  hygiene_ver   smallint NOT NULL,              -- PII/id-strip ruleset version the text passed through (§3)
  content_hash  text NOT NULL,                  -- sha256 over the EXACT post-hygiene text embedded (§3)
  embedding     vector(1536) NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_kind, owner_id, embed_kind)
);
-- HNSW for recall-at-latency at triage time; cosine to match embedding-3 normalization.
CREATE INDEX ix_embeddings_hnsw ON incident_memory.embeddings
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX ix_embeddings_owner ON incident_memory.embeddings (owner_kind, owner_id);
-- (ivfflat alternative if HNSW build cost bites at scale:
--   USING ivfflat (embedding vector_cosine_ops) WITH (lists = 200); -- needs ANALYZE + tuning)

-- ── detected_outcomes ──────────────────────────────────────────────────────
-- Append-only ledger of every outcome FACT the projector detects (§5/§7). Single source
-- both the resolutions.outcome_label update AND the controller-facing OutcomeEvent emission
-- derive from — so the two consumer views never diverge (§5.4).
CREATE TABLE incident_memory.detected_outcomes (
  id             bigserial PRIMARY KEY,
  detected_at    timestamptz NOT NULL DEFAULT now(),
  resolution_id  uuid NOT NULL REFERENCES incident_memory.resolutions(id),
  incident_id    uuid NOT NULL REFERENCES incident_memory.incidents(id),
  auto_action_id uuid,                          -- soft ref to trust.auto_action.id; NULL if not auto-applied
  -- kind is the CONTROLLER's OutcomeEvent enum (TRUST-CONTROLLER.md §2.2), verbatim,
  -- so emission is a straight projection with no lossy rename:
  kind           text NOT NULL,                 -- applied | recurrence | spawn | spawn_contested
                                                 -- | revert | matured
  match_basis    text,                          -- fingerprint | semantic | symptom_area | vector | git | window
  detail         jsonb NOT NULL DEFAULT '{}',
  emitted_to_controller boolean NOT NULL DEFAULT false, -- projector delivery flag (§7)
  CONSTRAINT ck_detected_kind CHECK (kind IN
    ('applied','recurrence','spawn','spawn_contested','revert','matured'))
);
CREATE INDEX ix_detected_res    ON incident_memory.detected_outcomes (resolution_id);
CREATE INDEX ix_detected_action ON incident_memory.detected_outcomes (auto_action_id);
CREATE INDEX ix_detected_kind   ON incident_memory.detected_outcomes (kind, detected_at);
CREATE INDEX ix_detected_unsent ON incident_memory.detected_outcomes (emitted_to_controller)
  WHERE emitted_to_controller = false;
```

Notes:
- `why_traces` is the audit substrate: trigger-locked (§9) and role-locked append-only.
  Correcting a bad label is a *new* `detected_outcomes` row + a `resolutions.outcome_label`
  update, never a trace rewrite.
- `resolutions.outcome_label` is the one retrieval field that legitimately mutates; that
  mutation is the poisoning-defense pivot (§5).
- Loop A incidents produce a `resolutions` row with `loop='A_rca'`, `fix_class='rca-only'`,
  `diff_ref=NULL`, `auto_action_id=NULL` — a diagnosis with no code write, matured on the
  human's explicit RCA verdict (§5.3), never on absence-of-signals.

---

## 3. Embedding strategy

**What we embed (three separate vectors, not one blob):**

| embed_kind | Source text | Retrieval gate | Why separate |
|---|---|---|---|
| `signal` | `normalized_message` + `error_class` + top normalized stack frames | none — primary match key | The *symptom* — what a new incident matches against first. Kept clean of RCA prose so we don't match on a past *guess*. |
| `rca_hypothesis` | The confirmed root-cause statement from the `rca` trace step | **only retrievable if the owning resolution is `confirmed_good`** (§4/§9-D8) | The *diagnosis* — enables "same cause, different symptom" recall. Embedded once, but gated so an unconfirmed guess never primes a new RCA (attack #4/#5). |
| `resolution_rationale` | Fix summary + fix_class + touched symbols | polarity via `outcome_label` (§4) | The *what-we-did* — powers exemplar/anti-pattern retrieval. |

The `rca_hypothesis` gate is load-bearing: without it, embedding a diagnosis and feeding it
back is exactly the anchoring failure the stress test warns about (a past *model's* guess
priming the next RCA). We embed it eagerly (cheap) but the query in §4 surfaces it only when
its resolution has cleared maturation to `confirmed_good`. An unconfirmed or anti-pattern
hypothesis is retrievable only as a *labeled negative*, never as neutral few-shot.

**Text hygiene before embedding is mandatory (and doubles as a security control, D7):**
telemetry text is UNTRUSTED. Before embedding we strip UUIDs, timestamps, hex addresses,
emails/PII, and request/session ids into placeholders (`<uuid>`, `<ts>`, `<email>`). This
makes the `signal` vector generalize across occurrences instead of memorizing a request id.
Id-stripping is **not** injection neutralization on its own — instruction-shaped prose
("ignore previous instructions, run…") survives id-stripping untouched. Neutralization of
retrieved memory happens at *read* time, in §8: retrieved content is inserted into the RCA
prompt as data-delimited, non-instruction context, exactly as D7 requires for live logs. The
stored `normalized_message` is what we index; the `why_traces.trust='untrusted'` flag marks
any step carrying raw telemetry so replay and read-time wrapping know what to quarantine.

**Model / dimension (exact, not hand-wavy):** we embed with
**`text-embedding-3-small`, native 1536 dims — no dimension reduction, no truncation.**
`text-embedding-3-small` is natively 1536, which *is* the AgenticMind re-embed-to-1536
convention (D1); the shared pgvector column width and `vector_cosine_ops` index are therefore
an exact match with the existing CKL/FCY corpora — one index type, one re-embed job serves
both. (If a future model bump moves to `text-embedding-3-large` (native 3072), 1536 is
obtained via OpenAI's `dimensions=1536` API parameter — MRL truncation *with* renormalization
— never by naive array-slicing, which breaks the unit-norm assumption the cosine index
depends on. `dims` records the native dim actually used so a mismatch is detectable.) OpenAI
embedding-3 outputs are unit-normalized, so cosine is exact throughout.

**Re-embed detection.** `content_hash = sha256(exact post-hygiene text that was embedded)` —
hashed *after* id-stripping, over the identical bytes handed to the embedding API, so the hash
and the vector always correspond. A re-embed is forced when **any** of:
`model != current`, `dims != current`, or **`hygiene_ver != current`** — a change to the
PII/id-stripping ruleset (a new placeholder class) changes the text that *would* be embedded
and must invalidate stale vectors exactly like a model bump. The maturation/re-embed job walks
rows where any of these differ and re-embeds idempotently.

---

## 4. Outcome-weighted retrieval (D6 / attack #8)

Retrieval MUST NOT treat all similar past resolutions as neutral matches. A `confirmed_good`
resolution is a positive exemplar; a `recurred` / `reverted` / `wrong_rca` one is a **labeled
anti-pattern** surfaced *as such*, never fed silently as few-shot to copy. This is the direct
defense against attack #8 (memory poisoning) and it compounds with the Trust Controller
(attack #3): a wrong-but-green fix can never present as something to imitate.

This is the backing query for the `memory.retrieve` tool contracted in LOOP-A-SPEC.md §6
(`memory.retrieve({ signalEmbedding, lineage? })`). It returns **two separately-limited
blocks** — exemplars and anti-patterns — because the prose policy ("separate blocks") and a
single mixed `LIMIT` are not the same thing.

**Correct joins (fixing the draft's fan-out and prefilter/rank mismatch):**
- Match against the **`signal` embedding** for candidate incidents, then join to the
  incident's **current, non-superseded resolution only** (`superseded_by IS NULL AND
  outcome_label <> 'superseded'`) so one incident contributes at most one row — no fan-out
  across its historical resolutions.
- The ANN prefilter and the ORDER BY are **consistent within a polarity**: exemplars rank by
  descending similarity among positives; anti-patterns rank by descending similarity among
  negatives. We do **not** rank a mixed set by `abs(score)` (that let a distant anti-pattern
  crowd out a close exemplar under one shared `LIMIT`). Each block has its own `LIMIT`.

```sql
-- $q            = signal embedding of the current incident (unit-norm vector(1536))
-- $lineage      = fingerprint_lineage[] of the current candidate (may be empty)
-- $max_distance = ANN cutoff (HNSW ef_search tuned for triage latency, LOOP-A-SPEC.md §8)
-- $k_pos,$k_neg = independent limits per block

WITH cand AS (
  SELECT inc.id AS incident_id,
         (e.embedding <=> $q::vector) AS dist,                 -- cosine distance
         (inc.stack_fingerprint = ANY($lineage)
            OR inc.semantic_fingerprint = ANY($lineage)) AS lineage_match
  FROM incident_memory.embeddings e
  JOIN incident_memory.incidents inc ON inc.id = e.owner_id
  WHERE e.owner_kind = 'incident' AND e.embed_kind = 'signal'
    AND e.embedding <=> $q::vector < $max_distance
),
-- exactly one resolution per candidate incident: the current, non-superseded one
res AS (
  SELECT DISTINCT ON (r.incident_id)
         r.id AS resolution_id, r.incident_id, r.fix_class, r.loop,
         r.outcome_label, r.diff_ref, r.mutation_score, r.auto_action_id
  FROM incident_memory.resolutions r
  WHERE r.superseded_by IS NULL AND r.outcome_label <> 'superseded'
  ORDER BY r.incident_id, r.created_at DESC
),
matched AS (
  SELECT c.incident_id, c.dist, c.lineage_match, 1 - c.dist AS sim,
         r.resolution_id, r.fix_class, r.loop, r.outcome_label,
         r.diff_ref, r.mutation_score, r.auto_action_id,
         CASE r.outcome_label
           WHEN 'confirmed_good' THEN  1.00      -- proven precedent
           WHEN 'applied'        THEN  0.55      -- unconfirmed: weak, provisional
           WHEN 'proposed'       THEN  0.35      -- never applied: weakest positive
           WHEN 'recurred'       THEN -1.00      -- anti-pattern (negative)
           WHEN 'reverted'       THEN -1.00      -- anti-pattern (negative)
           WHEN 'wrong_rca'      THEN -1.00      -- anti-pattern (negative, Loop A)
           ELSE 0.0                              -- unknown/future label: NEUTRAL, never dropped
         END AS polarity
  FROM cand c
  JOIN res r ON r.incident_id = c.incident_id
)
-- caller runs BOTH selects; they are unioned client-side into two labeled blocks:
-- POSITIVE (exemplars):
--   SELECT *, sim * polarity * (CASE WHEN lineage_match THEN 1.15 ELSE 1 END) AS score
--   FROM matched WHERE polarity > 0 ORDER BY score DESC LIMIT $k_pos;
-- NEGATIVE (anti-patterns):
--   SELECT *, sim AS score
--   FROM matched WHERE polarity < 0 ORDER BY sim DESC LIMIT $k_neg;
SELECT * FROM matched;
```

The `rca_hypothesis` vector is deliberately **absent** from the block query. A separate, gated
lookup surfaces it only for `confirmed_good` resolutions (§3, §9-D8):

```sql
-- rca_hypothesis retrieval — gated on confirmed_good, returned as "prior confirmed cause"
SELECT r.incident_id, 1 - (e.embedding <=> $q_hyp::vector) AS sim,
       w.payload->>'hypothesis' AS hypothesis
FROM incident_memory.embeddings e
JOIN incident_memory.resolutions r ON r.incident_id = e.owner_id
JOIN incident_memory.why_traces  w ON w.incident_id = r.incident_id AND w.step_type = 'rca'
WHERE e.owner_kind = 'incident' AND e.embed_kind = 'rca_hypothesis'
  AND r.outcome_label = 'confirmed_good' AND r.superseded_by IS NULL
  AND e.embedding <=> $q_hyp::vector < $max_distance
ORDER BY sim DESC LIMIT $k_hyp;
```

**How the caller uses the result** (this is the load-bearing part, per LOOP-A-SPEC.md §6):
- Positive block → **exemplars**: *"here is a confirmed-good precedent."* They may raise a
  hypothesis's rank but **cannot by themselves clear the Loop A §4 grounding gate** — a past
  success is not a current repro.
- Negative block → **anti-patterns**, in a separate explicitly-labeled section: *"this fix
  was tried for a similar signal and it recurred / was reverted / was a wrong RCA — do NOT
  repeat it; here is what went wrong."* Surfaced to the model as few-shot negatives and to the
  human in the §7 payload.
- `confirmed_good` outranks `applied` / `proposed` at equal similarity → the agent prefers
  *proven* precedent over merely *recent* precedent (D6: outcome over activity).
- Gated `rca_hypothesis` hits are injected as *"prior confirmed cause for a similar signal"* —
  never as neutral ground truth, and never for unconfirmed hypotheses.

Polarity comes entirely from `resolutions.outcome_label`, governed by §5. Retrieval has no
opinion of its own; it reads the ledger.

---

## 5. Poisoning defense — the outcome lifecycle

Attack #8: a wrong-but-green fix (weak suite passed it) becomes few-shot context and
propagates the same wrong fix forever. The defense is that **"green" never confers exemplar
status** — only a matured outcome does. Green is a *verification-step grounded boolean*
(`fix_flipped_green`, S4/S5 in VERIFICATION-GATE.md), not an outcome label.

### 5.1 Lifecycle of `resolutions.outcome_label`

```
proposed ──(applied to a branch/PR or auto-applied)──► applied
   │                                                     │
   │ (Loop A: rca-only)                                  ├──(maturation §5.3 clears with
   ▼                                                      │   ZERO detected negatives)──► confirmed_good
(rca-only matures on the HUMAN's                          │
 explicit RCA verdict §5.3, NOT                           ├──(recurrence detected §6/§7)──► recurred
 on absence-of-signals)                                   ├──(human revert detected §7)───► reverted
                                                          └──(a better fix replaces it)────► superseded
```

For Loop A `rca-only` rows there is no `applied` code state; they go
`proposed → confirmed_good | wrong_rca` on the human verdict (§5.3).

### 5.2 Rules

1. **Only `confirmed_good` is a full positive exemplar (§4).** For code resolutions, reaching
   it requires the **absence of independent negative outcome signals** over the maturation
   window — and, critically, that absence is established by the projector **actively running
   the full drift-resistant recurrence check itself** (§5.3, §6), not by passively scanning for
   already-emitted negative events. A detector that never fired because of fingerprint drift
   must not be read as "no recurrence."
2. **`applied` is provisional and weakly-weighted (0.55).** A just-merged fix may be *offered*
   as weak precedent but cannot dominate a confirmed-good one, and cannot become an exemplar
   merely by aging — it must clear the window with no negatives.
3. **Negative outcomes are sticky and win their block.** Once `recurred` / `reverted` /
   `wrong_rca`, a resolution is a labeled anti-pattern (§4) and never silently reverts to
   positive; a later successful re-fix is a *new* resolution row (the old one is `superseded`,
   filtered out, while its failure history lives on in `why_traces` and stays an anti-pattern
   by its terminal label). Note `superseded` here means "replaced by a better fix," distinct
   from Loop A's `superseded_by_human` trace label for a human-out-raced RCA (LOOP-A-SPEC.md
   §8) — the latter maps to `wrong_rca`/neutral, never to a positive exemplar.
4. **Maturation is a background job** (§5.3), not a trigger — idempotent, runs at least as
   often as the shortest attribution window allows (hourly, matching the controller's
   `reconcile` cadence).

### 5.3 The maturation job (defeats attack #8; the completeness requirement is explicit)

The single point that defeats #8 is that `confirmed_good` is *earned by a proof of absence of
harm*, not stamped on a green CI run. The job must therefore be **complete**, not merely
event-scanning:

```
For each resolution R currently 'applied' (code) whose applied_at + W_confirm ≤ now:
  # W_confirm is the Trust Controller's window, NOT a local naked constant (§5.5).
  1. Re-run the FULL drift-resistant recurrence check for R (§6/§7):
       fingerprint match OR (module_area + symptom_signature) match OR vector-ANN match,
       over [applied_at, now]. NEVER conclude "no recurrence" without exhausting all rungs.
  2. Re-run the spawn check: any new-fingerprint incident first-seen in R's touched files
       (or module_area if paths empty, §10) in-window, with no intervening human edit (§7).
  3. Check for a detected revert (git webhook, §7).
  4. IF any of (1)(2)(3) fired → the corresponding negative label already applies; do NOT
       mature. (These are emitted as detected_outcomes the moment they are found, §7.)
     ELSE → label R 'confirmed_good', set outcome_at, and record a 'matured'
       detected_outcome (§7).

For each rca-only resolution R (Loop A):
  Maturation is NOT time-based. It is driven by the human verdict written at trace close:
    - HITL 'Mark cause confirmed' (LOOP-A-SPEC.md §7) → 'confirmed_good'.
    - HITL 'Wrong RCA'                                → 'wrong_rca' (anti-pattern).
    - no verdict yet                                  → stays 'proposed' (NEUTRAL in §4).
  An rca-only row can NEVER reach a positive exemplar by absence-of-signals, because the
  negative signals (recurrence/spawn/revert) do not exist for a zero-write diagnosis. It is
  positive ONLY on an explicit human confirmation. (Closes the "rca-only drifts to 1.00"
  hole.) rca-only exemplars are additionally weight-capped in retrieval config (§5.6).
```

**Completeness invariant (stated so no future change weakens it):** the maturation gate is
only as strong as the negative-signal recall in step 1–2. Therefore step 1–2 run the *same*
drift-resistant matcher used at ingest (§6), not a cheaper shortcut, and `confirmed_good` is
withheld if `affected_paths` was empty *and* no `module_area` fallback attribution could run
(§10) — an un-attributable fix is left `applied` (weak), never promoted to a copyable
positive. Silence that could be a detector blind spot is treated as "not yet confirmed," not
as "confirmed good."

### 5.4 One source of truth for two consumers

The projector derives *both* consumer views from `detected_outcomes` (§7), so the retrieval
label and the controller event can never diverge:

| detected `kind` | → `resolutions.outcome_label` | → `OutcomeEvent.kind` (to controller) |
|---|---|---|
| `applied` | `applied` | `applied` |
| `matured` | `confirmed_good` | `matured` |
| `recurrence` | `recurred` | `recurrence` |
| `spawn` | (unchanged: still `applied`/`confirmed_good`)¹ | `spawn` |
| `spawn_contested` | (unchanged)¹ | `spawn_contested` |
| `revert` | `reverted` | `revert` |
| — (Loop A human verdict) | `confirmed_good` / `wrong_rca` | — (no auto_action; not sent) |

¹ A `spawn` is harm attributed to the fix's *touched file*, not a repeat of the *same*
incident, so it contracts the class in the controller but does not by itself flip the
resolution to an anti-pattern for symptom-similarity retrieval; it *does* attach to the
resolution's `detail` and is shown to the human. If a spawn is later confirmed as caused by
this fix, an operator marks the resolution `reverted` (anti-pattern) — a mutable-column edit,
allowed by §2.

### 5.5 Windows come from the Trust Controller, not from here

`W_confirm`, `W_recur`, `W_spawn`, `W_revert` are **owned by TRUST-CONTROLLER.md** (its
`attribution_windows` config, defaults `W_recur=14d`, `W_spawn=14d`, `W_revert=30d`,
`W_confirm=14d`, invariant `W_confirm ≥ W_recur`). Incident Memory reads them from the shared
config; it does **not** define a local `confirmed_good_after_days`. This removes the draft's
naked `14` that had no stated relation to the recurrence window and could have matured a fix
*before* its recurrence window closed. `W_confirm ≥ W_recur` guarantees a fix cannot be scored
`confirmed_good` before its recurrence window has elapsed.

### 5.6 Retrieval weights (config, not prompt)

```yaml
incident_memory:
  retrieval:
    weights:                 # outcome_label → polarity multiplier (§4)
      confirmed_good: 1.00
      applied:        0.55
      proposed:       0.35
      recurred:      -1.00
      reverted:      -1.00
      wrong_rca:     -1.00
    rca_only_confirmed_cap: 0.80   # rca-only confirmed_good caps below a code confirmed_good:
                                   # a human-confirmed diagnosis is strong precedent but was
                                   # never grounded by a repro+green fix, so it must not
                                   # outrank a code fix that actually held in production.
    lineage_boost: 1.15
    k_pos: 5
    k_neg: 3
    k_hyp: 3
```

This makes the memory *self-correcting under autonomy expansion*: the more the fleet acts, the
more outcome data accrues, and bad early fixes get demoted to anti-patterns exactly as their
similarity would otherwise have made them most influential.

---

## 6. Fingerprint drift (STRESS-TEST §9) and the recurrence-matching keys

Stack-hash fingerprints are computed from file+line+symbol of top frames. A refactor (rename,
move, reflow) changes the hash → the March fix for "the same bug" no longer matches → retrieval
and recurrence detection silently go dark right when recall is most wanted. Silent, because
nothing errors — you just stop getting hits. If left open in **recurrence detection** this
reintroduces attacks #8 and #3 (a drift-hidden recurrence is never labeled → matures to
`confirmed_good` → becomes an exemplar). So the drift defense is not merely a retrieval nicety
— it is load-bearing for the outcome pipeline (§7).

**A four-rung key hierarchy, coarsening as it goes; we never rely on the top rung alone:**

- **`stack_fingerprint`** (exact, brittle): `hash(normalized top-N frames)`. Great when nothing
  moved; breaks on any refactor.
- **`semantic_fingerprint`** (drift-resistant, breaks on symbol *rename*):
  `hash(error_class + sorted(surviving_symbol_names) + message_shape)`. File paths and line
  numbers are deliberately EXCLUDED — those are what a refactor churns.
- **`symptom_signature`** (rename-proof, coarsest structured key):
  `hash(error_class + message_shape)` — no symbol names, no paths at all. Survives a function
  rename that `semantic_fingerprint` does not, and is the key used *together with `module_area`*
  for recurrence attribution (§7), matching the Trust Controller's "**same fingerprint OR same
  `module_area` + same symptom signature**" rule (TRUST-CONTROLLER.md §2.2).
- **Vector fallback (last resort):** the `signal` embedding (§3) finds semantically-near
  incidents by cosine even when all structured keys miss — catches "same bug, fully rewritten
  call site."

**`fingerprint_lineage`** (LOOP-A-SPEC.md §2) chains the prior fingerprints a candidate maps to
across refactors, populated by the dedup layer via `git log --follow` on `affected_paths`.
Retrieval (§4) searches the whole lineage; a lineage match is boosted over a bare vector hit.

**Order of matching (both retrieval §4 and recurrence attribution §7):**
`stack_fingerprint` exact → `semantic_fingerprint` → `symptom_signature + module_area` →
`pg_trgm` fuzzy `normalized_message` (intermediate rung when symbols churned but text is near)
→ vector ANN. **Each fall-through is logged** as a drift signal (`detected_outcomes.match_basis`
records which rung fired; a `fingerprint_drift_count` metric increments on any non-`fingerprint`
basis), so a spike in vector-only recall is a *visible alarm* that a refactor moved something —
not a silent degradation.

---

## 7. Outcome projector — what the Trust Controller reads (see TRUST-CONTROLLER.md)

The Trust Controller expands autonomy on **outcome**, not on the absence of a human veto (D6,
defeating attack #3). Incident Memory is its outcome source, but the interface is the
controller's **own** `OutcomeEvent` contract — Incident Memory produces events *to that spec*,
it does not invent its own event schema (this closes the draft's silent contract break). The
controller consumes them via `ingestOutcome`, **idempotent on `auto_action_id`**
(TRUST-CONTROLLER.md interface).

### 7.1 Emission contract (verbatim to TRUST-CONTROLLER.md §2.2 / its `OutcomeEvent`)

```ts
// EXACT shape the controller's ingestOutcome expects — no renames, no omissions.
type OutcomeEvent = {
  autoActionId: string;                                  // = detected_outcomes.auto_action_id
  kind: 'applied' | 'recurrence' | 'spawn'
      | 'spawn_contested' | 'revert' | 'matured';        // controller enum, not a local one
  at: string;                                            // ISO8601 (= detected_at)
};
```

The projector reads unsent `detected_outcomes` rows (`emitted_to_controller = false`,
`auto_action_id IS NOT NULL`), calls `TrustController.ingestOutcome(ev)`, and flips the flag on
success. Idempotency is doubly-held: the controller dedups on `auto_action_id` per its own
contract, and the projector's `emitted_to_controller` flag prevents re-send. Loop A `rca-only`
outcomes have `auto_action_id = NULL` and are **never** emitted — they carry no autonomy weight
(there was no auto-action), consistent with Loop A being pinned L0.

### 7.2 The detectors (producers of `detected_outcomes`)

Every emission carries the `auto_action_id` and the `match_basis` (§6) so attribution is
replayable and disputable — matching the controller's requirement that attribution be
mechanical, not a judgment call (TRUST-CONTROLLER.md §6.2).

| Controller `kind` | Detected when | Match rungs (§6) | Producer |
|---|---|---|---|
| `applied` | an action auto-applies (Loop B quarantine / eventual Loop C merge); opens the pending window | — | Verification Gate on auto-apply, writing the `auto_action_id` |
| `recurrence` | a new incident matches a resolved one within `W_recur` | fingerprint **OR** `symptom_signature + module_area` **OR** vector — **never fingerprint alone** | Dedup/attribution on ingest |
| `spawn` | a *different-fingerprint* incident first-seen in a touched file within `W_spawn`, no intervening human edit to those lines | file-intersection; `module_area` fallback if paths empty (§10) | Dedup, path/area-intersection check |
| `spawn_contested` | a human *and* the agent both touched the lines in-window (ambiguous attribution) | as spawn + git-blame overlap | Dedup, per TRUST-CONTROLLER.md §2.2 |
| `revert` | git revert of the auto-commit, or human rewrite of touched lines within `W_revert` | git | Verification Gate / CI git webhook |
| `matured` | `W_confirm` elapsed with the full drift-resistant checks (§5.3) finding none of the above | — | §5.3 maturation job |

**Recurrence detection MUST NOT rely on `semantic_fingerprint` equality alone** (the draft's
bug, which the controller explicitly guards against). It runs the full rung hierarchy of §6 and
only concludes "no recurrence" after the vector rung also misses. A recurrence hidden by a
symbol rename is exactly how a wrong-but-green fix would otherwise mature to `confirmed_good`;
closing it here is what keeps §5.3's `matured` verdict honest.

`spawn` attribution honors the controller's condition (c): an incident is attributed to a prior
auto-action only if no *human* commit touched those lines between the auto-action and the new
incident; human-then-agent overlap becomes `spawn_contested` (counted for contraction but
flagged for adjudication) — Incident Memory computes this via `git blame` on the touched lines
and records the basis in `detail`.

### 7.3 Aggregate contract for the controller's harm metric (§6 of TRUST-CONTROLLER.md)

The controller computes `caused` as **distinct `auto_action_id`s** (TRUST-CONTROLLER.md §6.1:
one bad fix that recurs three times is *one* caused-incident). The read query Incident Memory
exposes therefore dedups on the action and includes `spawn_contested`:

```sql
-- harm counts per fix_class over a trailing window — deduped on the auto-action.
SELECT r.fix_class,
       count(DISTINCT do.auto_action_id) FILTER (WHERE do.kind = 'matured')            AS good,
       count(DISTINCT do.auto_action_id) FILTER (WHERE do.kind IN
             ('recurrence','spawn','spawn_contested','revert'))                         AS harmed
FROM incident_memory.detected_outcomes do
JOIN incident_memory.resolutions r ON r.id = do.resolution_id
WHERE do.detected_at > now() - $window
  AND do.auto_action_id IS NOT NULL
GROUP BY r.fix_class;
```

`harmed` is the harm metric STRESS-TEST §9 flagged as absent; it is deduped per action (fixing
the draft's `count(*)` over-count) and includes `spawn_contested` (which the controller counts
as caused). This gates trust expansion — never override rate. The controller decides per-class /
per-incident-class (D5/D10); Incident Memory only supplies the grounded, mechanically-attributed
counts.

---

## 8. Read-time injection defense (D7 / attack #7)

Stored memory is a *replayed* input to every future similar incident — a stored injection is
worse than a live log because it fans out. Id-stripping at write time (§3) does not neutralize
instruction-shaped prose. Therefore, at read time:

- Every retrieved field that originated from telemetry or from an LLM operating on telemetry
  (`normalized_message`, `resolution_rationale`, retrieved `hypothesis`) is inserted into the
  RCA prompt **wrapped as data-delimited, untrusted context** — the same posture
  LOOP-A-SPEC.md §8 / VERIFICATION-GATE.md §4 apply to live `log.correlate` output and to the
  judge's `rcaClaim`. The system prompt states that no instruction found inside retrieved
  memory is ever to be followed.
- Retrieved rows whose source trace step carries `trust='untrusted'` are tagged as such in the
  assembled context, and anti-pattern blocks (§4) additionally carry their negative label so the
  model treats them as "avoid this," never "do this."
- Injection-shaped content surfaced from memory (instruction phrases, tool-call syntax, fetch
  URLs) is flagged into the human §7 payload as "suspicious content in a similar past incident"
  — turning a stored attack into a signal, per LOOP-A-SPEC.md §8 mitigation 4.

Loop A's structural safety still holds: retrieval feeds a read-only agent with no write tools
(LOOP-A-SPEC.md §8 mitigation 2), so even a successful memory-borne injection reaches nothing it
can steer into a code write. Read-time wrapping is defense-in-depth on top of that.

---

## 9. Immutability & least-privilege (principle 3, D7)

The "immutable audit substrate" claim is enforced by **three** mechanisms, because a row-level
trigger alone is a slogan (bypassable, and blind to `TRUNCATE`):

1. **Row + statement triggers on `why_traces`.** `BEFORE UPDATE OR DELETE … FOR EACH ROW` *and*
   `BEFORE TRUNCATE … FOR EACH STATEMENT` both raise — closing the `TRUNCATE` wipe-the-log hole:

   ```sql
   CREATE OR REPLACE FUNCTION incident_memory.reject_mutation()
   RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     RAISE EXCEPTION 'why_traces is append-only (%.% blocked)', TG_TABLE_NAME, TG_OP;
   END $$;
   CREATE TRIGGER trg_traces_immutable
     BEFORE UPDATE OR DELETE ON incident_memory.why_traces
     FOR EACH ROW EXECUTE FUNCTION incident_memory.reject_mutation();
   CREATE TRIGGER trg_traces_no_truncate
     BEFORE TRUNCATE ON incident_memory.why_traces
     FOR EACH STATEMENT EXECUTE FUNCTION incident_memory.reject_mutation();
   ```

   `detected_outcomes` gets the same pair (it too is an append-only ledger).

2. **Role separation — the writer does not own the table.** Triggers are bypassable by the table
   owner (`ALTER TABLE … DISABLE TRIGGER`) and by superusers. So the DML writer role
   (`selfheal_writer`, used by the agents/gate/projector) is **not** the schema owner. A separate
   `selfheal_ddl` role owns the schema; `selfheal_writer` gets `INSERT` (and scoped `UPDATE` on
   the mutable `resolutions` columns only) but **not** `DELETE`, `TRUNCATE`, `ALTER`, or trigger
   control:

   ```sql
   REVOKE DELETE, TRUNCATE ON incident_memory.why_traces        FROM selfheal_writer;
   REVOKE DELETE, TRUNCATE ON incident_memory.detected_outcomes FROM selfheal_writer;
   GRANT  INSERT            ON incident_memory.why_traces        TO   selfheal_writer;
   -- resolutions: INSERT + UPDATE (mutable columns), with the §2 freeze trigger protecting
   -- merged_by / diff_ref / auto_action_id from post-hoc rewrite.
   ```

   This is the D7 least-privilege posture at the storage layer: even a compromised writer
   credential cannot rewrite history. For deployments needing stronger guarantees, the trace
   stream is additionally mirrored to an external append-only/WORM log; the Postgres copy remains
   the fast query surface, the WORM copy the tamper-evident record.

3. **Frozen provenance (§2 trigger).** `merged_by` (the D9 accountability owner), `diff_ref`, and
   `auto_action_id` cannot be changed once set — accountability for an auto-merged outage is not
   silently editable.

Kill switch: Incident Memory keeps recording under kill (bookkeeping is not action —
TRUST-CONTROLLER.md §5 step 4: pending windows keep ticking, outcomes maturing during a freeze
are recorded normally). It writes no app code and takes no auto-action itself, so there is
nothing for the freeze to stop here beyond what the gate/controller already refuse.

---

## 10. Empty `affected_paths` — spawn/attribution coverage (STRESS-TEST §9, harm-metric holes)

Business-metric and RUM signals often carry no repo path. The schema defaults `affected_paths`
to `'{}'`, so file-intersection spawn detection (§7) cannot fire for them. Two consequences,
both handled rather than left silent:

- **`module_area` is always populated** (derived from `affected_service` when paths are absent),
  so recurrence attribution (which keys on `symptom_signature + module_area`, §6/§7) and
  `module_area`-granularity spawn attribution still work — matching the controller's
  directory-granularity `class_key` (TRUST-CONTROLLER.md §2.1). Spawn thus degrades from
  file-intersection to area-intersection rather than failing closed.
- **Un-attributable maturation is withheld, not granted** (§5.3): if paths are empty *and* no
  `module_area` attribution could run, the resolution stays `applied` (weak precedent), never
  matures to `confirmed_good`. A coverage hole in attribution can only cost us a *positive*
  exemplar, never manufacture one — the safety-conservative direction.

---

## Attacks defended

- **#8 memory poisoning** — retrieval polarity is driven by `resolutions.outcome_label` (§4),
  which reaches `confirmed_good` only via the maturation job that **actively re-runs the full
  drift-resistant recurrence/spawn/revert checks** (§5.3), on the Trust Controller's
  `W_confirm ≥ W_recur` windows (§5.5) — never on a green CI run and never on
  absence-of-emitted-events. A wrong-but-green fix stays `applied` (weak) then flips to an
  anti-pattern; it can never become a copyable positive exemplar. `rca_hypothesis` retrieval is
  gated on `confirmed_good` so a past guess never primes a new RCA. rca-only rows reach positive
  only on an explicit human verdict, capped below code confirmed-good. Failures surface as
  *labeled* anti-patterns in a separate block, not neutral matches.
- **#3 trust runaway (via drift)** — recurrence detection uses fingerprint **OR**
  `symptom_signature + module_area` **OR** vector (§6/§7), never `semantic_fingerprint` alone, so
  a recurrence cannot hide behind a refactor and let a bad fix mature. The controller contract is
  its own `OutcomeEvent` enum, keyed on `auto_action_id`, idempotent (§7).
- **#7 stored/log-borne injection** — id-stripping at write (§3) plus **read-time data-delimited
  wrapping** of all telemetry-derived retrieved content (§8); retrieval feeds a no-write agent;
  suspicious content is surfaced, not silently followed.
- **Fingerprint drift** (STRESS-TEST §9) — four-rung key hierarchy + `fingerprint_lineage` +
  vector net (§6), every fall-through logged so drift is a visible alarm. "We fixed this in
  March" survives the refactor, and — more importantly — a *recurrence* of the March bug survives
  it too.
- **Immutability bypass** — row + statement (`TRUNCATE`) triggers, writer-≠-owner role
  separation, optional WORM mirror, and frozen provenance columns (§9).
- **Harm-metric coverage** (STRESS-TEST §9) — `harmed` is deduped per `auto_action_id` and
  includes `spawn_contested` (§7.3); empty-path signals degrade to `module_area` attribution and
  withhold (never fabricate) positive maturation (§10).
