/**
 * Canonical Postgres DDL (ARCHITECTURE-REFRAMED §3.2/§3.5/§3.6). Exported as strings so the
 * incident-memory + orchestrator packages run the SAME schema — the auto_action table has ONE shape
 * (keystone §3.2 supersedes the divergent draft DDLs). Schema `orch` owns auto_action.
 */

export const DDL_AUTO_ACTION = `
CREATE SCHEMA IF NOT EXISTS orch;
CREATE TABLE IF NOT EXISTS orch.auto_action (
  action_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id       UUID NOT NULL,
  class_key         TEXT NOT NULL,                       -- (module_area, symptom_signature)
  loop              TEXT NOT NULL CHECK (loop IN ('B','C')),
  applied_by        TEXT NOT NULL CHECK (applied_by IN ('machine','human_approved')),
  applied_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  fix_sha           TEXT NOT NULL,
  parent_sha        TEXT NOT NULL,
  gate_result       JSONB NOT NULL,
  accountable_owner TEXT NOT NULL,                       -- = trust_class.owner (D9), frozen
  module_area       TEXT NOT NULL,
  UNIQUE (incident_id, fix_sha)                          -- apply-time-writer idempotency (ORCH §5, MAJOR #5)
);`.trim()

export const DDL_RESOLUTIONS = `
CREATE SCHEMA IF NOT EXISTS incident_memory;
CREATE TABLE IF NOT EXISTS incident_memory.resolutions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id      UUID NOT NULL,
  auto_action_id   UUID REFERENCES orch.auto_action(action_id),   -- set for BOTH landing variants; NULL only for pure Loop A
  ck_outcome_label TEXT NOT NULL DEFAULT 'proposed' CHECK (ck_outcome_label IN
    ('proposed','applied','provisional_human_confirmed','confirmed_good','recurred','reverted','wrong_rca','superseded')),
  merged_by        TEXT,                                 -- descriptive audit only (NOT the accountability owner)
  matured_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- freeze: once auto_action_id is set it cannot change (idempotency backstop, ORCH §5)
CREATE OR REPLACE FUNCTION incident_memory.trg_resolutions_freeze() RETURNS trigger AS $$
BEGIN
  IF OLD.auto_action_id IS NOT NULL AND NEW.auto_action_id IS DISTINCT FROM OLD.auto_action_id THEN
    RAISE EXCEPTION 'resolutions.auto_action_id is frozen once set';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS resolutions_freeze ON incident_memory.resolutions;
CREATE TRIGGER resolutions_freeze BEFORE UPDATE ON incident_memory.resolutions
  FOR EACH ROW EXECUTE FUNCTION incident_memory.trg_resolutions_freeze();`.trim()

export const DDL_TRUST_CLASS = `
CREATE SCHEMA IF NOT EXISTS trust;
CREATE TABLE IF NOT EXISTS trust.trust_class (
  class_key    TEXT PRIMARY KEY,                         -- (module_area, symptom_signature)
  trust_loop   TEXT NOT NULL CHECK (trust_loop IN ('A_rca','B_flaky','B_heal','C_repair')),
  level        TEXT NOT NULL DEFAULT 'L1' CHECK (level IN ('L0','L1','L2','L3')),
  owner        TEXT,                                     -- D9 authoritative source of the accountability owner
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (level IN ('L0','L1') OR owner IS NOT NULL)       -- no auto-apply level without a named owner (D9)
);`.trim()

export const DDL_INCIDENTS = `
CREATE SCHEMA IF NOT EXISTS incident_memory;
CREATE TABLE IF NOT EXISTS incident_memory.incidents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint   TEXT NOT NULL,
  symptom_signature TEXT,                                -- rename-proof recurrence key (drift fallback)
  module_area   TEXT,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','diagnosed','resolved','closed')),
  notify_state  TEXT NOT NULL DEFAULT 'investigating' CHECK (notify_state IN ('investigating','notified')),
  first_seen    TIMESTAMPTZ NOT NULL DEFAULT now()
);`.trim()

/** why-trace store + embeddings (pgvector, reused AgenticMind infra, D1). 1536-dim per convention. */
export const DDL_WHY_TRACES = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS incident_memory.why_traces (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id   UUID NOT NULL,
  trace         JSONB NOT NULL,                          -- immutable WhyTrace
  content_hash  TEXT NOT NULL,
  embedding     vector(1536),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS why_traces_embedding_idx ON incident_memory.why_traces
  USING hnsw (embedding vector_cosine_ops);`.trim()

/**
 * Outcome-weighted retrieval as a SQL function (INCIDENT-MEMORY.md §4, attack #8). Cosine-ranks each
 * incident's newest non-superseded resolution by its why-trace embedding, weights by outcome-label
 * polarity (confirmed_good=1, weak positives 0.35–0.55, anti-patterns −1, superseded filtered), and
 * returns two blocks: `exemplar` (positives, ranked by similarity×weight) and `anti` (labeled, ranked
 * by similarity) — so a wrong-but-green fix never presents as something to imitate.
 */
export const DDL_RETRIEVE_FN = `
CREATE OR REPLACE FUNCTION incident_memory.retrieve_outcome_weighted(query_vec text, k_pos int, k_neg int)
RETURNS TABLE(resolution_id uuid, incident_id uuid, label text, block text, similarity double precision, weight double precision)
LANGUAGE sql STABLE AS $fn$
  WITH current_res AS (
    SELECT DISTINCT ON (r.incident_id) r.id, r.incident_id, r.ck_outcome_label AS label, r.created_at
      FROM incident_memory.resolutions r
     WHERE r.ck_outcome_label <> 'superseded'
     ORDER BY r.incident_id, r.created_at DESC
  ),
  scored AS (
    SELECT cr.id AS resolution_id, cr.incident_id, cr.label,
           (1 - (w.embedding <=> query_vec::vector))::double precision AS similarity,
           (CASE cr.label
              WHEN 'confirmed_good' THEN 1.0 WHEN 'applied' THEN 0.55
              WHEN 'provisional_human_confirmed' THEN 0.5 WHEN 'proposed' THEN 0.35
              WHEN 'recurred' THEN -1.0 WHEN 'reverted' THEN -1.0 WHEN 'wrong_rca' THEN -1.0
              ELSE 0.0 END)::double precision AS weight,
           (CASE WHEN cr.label IN ('recurred','reverted','wrong_rca') THEN 'anti' ELSE 'exemplar' END) AS block
      FROM current_res cr
      JOIN LATERAL (
        SELECT wt.embedding FROM incident_memory.why_traces wt
         WHERE wt.incident_id = cr.incident_id AND wt.embedding IS NOT NULL
         ORDER BY wt.created_at DESC LIMIT 1
      ) w ON true
  )
  (SELECT resolution_id, incident_id, label, block, similarity, weight FROM scored WHERE block = 'exemplar' ORDER BY similarity * weight DESC LIMIT k_pos)
  UNION ALL
  (SELECT resolution_id, incident_id, label, block, similarity, weight FROM scored WHERE block = 'anti' ORDER BY similarity DESC LIMIT k_neg)
$fn$;`.trim()

/**
 * The durable kill bit (ARCHITECTURE-REFRAMED §5, ORCHESTRATION.md). A single-row table (PK id=true +
 * CHECK(id)) so the kill state survives process restarts — the whole point of the durable orchestrator.
 * Fail-safe read: absence of a healthy heartbeat = KILLED (enforced in PgKillSwitch, not the schema).
 */
export const DDL_KILL_SWITCH = `
CREATE TABLE IF NOT EXISTS orch.kill_switch (
  id            boolean PRIMARY KEY DEFAULT true CHECK (id),
  engaged       boolean NOT NULL DEFAULT false,
  heartbeat_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO orch.kill_switch (id) VALUES (true) ON CONFLICT (id) DO NOTHING;`.trim()

/** All migrations, in dependency order. */
export const MIGRATIONS: { name: string; sql: string }[] = [
  { name: '0001_auto_action', sql: DDL_AUTO_ACTION },
  { name: '0002_incidents', sql: DDL_INCIDENTS },
  { name: '0003_resolutions', sql: DDL_RESOLUTIONS },
  { name: '0004_trust_class', sql: DDL_TRUST_CLASS },
  { name: '0005_why_traces', sql: DDL_WHY_TRACES },
  { name: '0006_retrieve_fn', sql: DDL_RETRIEVE_FN },
  { name: '0007_kill_switch', sql: DDL_KILL_SWITCH },
]
