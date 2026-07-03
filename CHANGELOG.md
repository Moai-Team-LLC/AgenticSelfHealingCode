# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/) (pre-1.0: minor bumps may break).

## [Unreleased]

### Added

- **60-second onboarding**: `bun run demo` (zero-config live demo of the whole pipeline over real
  HTTP — grounded CONFIRMED, honest ESCALATE with named missing evidence, spoof rejection,
  injection flagging, duplicate suppression), `bun run migrate` (migration CLI), `bun run
  send-signal` (signed-webhook example client), `docker-compose.yml` (Postgres + pgvector + the
  service), README restructured demo-first, and a fresh-clone demo smoke in CI.
- Optional platform adapters for the AgenticProduct ecosystem: AgenticOps
  (Telemetry + Backlog), AgenticMind (incident memory over the MCP contract),
  APL (OTel-shaped agent-performance telemetry) — each behind a `@sho/contracts`
  port with a standalone in-repo default. See `INTEGRATIONS.md`.
- `CONFORMANCE.md` — mapping onto the Agentic Product Standard.

## [0.1.0] — 2026-07-02

Initial public release.

### Added

- **Design package** — adversarially reviewed architecture: `ARCHITECTURE-REFRAMED.md`
  (source of truth), `STRESS-TEST.md`, `DECISIONS.md` (D1–D10), component specs,
  `BUILD-PLAN.md`, `SECURITY-THREATMODEL.md`.
- **Product monorepo** (12 `@sho/*` packages, Bun workspace, zero runtime deps):
  contracts, trust-controller (outcome-based autonomy, fast-demote), incident-memory
  (outcome-weighted retrieval, drift-resistant recurrence), aggregation, signal-layer
  (HMAC-verified ingestion), orchestrator (durable kill bit / notify CAS / auto_action
  ledger), loop-a (RCA copilot, zero write access), loop-b (test-suite self-healing
  discriminator), hitl (approval ladder + business-hours gate), pipeline (end-to-end
  vertical slice), adapters (Telegram, Claude), app (deployable signal-intake service).
- **Reference kernels** — D10 MTTR instrument (+ CSV/PagerDuty/Linear/Sentry adapters),
  must-fail-on-parent verification gate, mutation-score gate, integrated `verify()`
  + CI workflow, Loop B discriminator.
- **Live verification** against real Postgres 16 + pgvector: 36 checks (incident-memory
  path, durable orchestrator incl. restart-survival, app end-to-end with durable
  no-double-notify).
