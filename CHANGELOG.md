# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/) (pre-1.0: minor bumps may break).

## [Unreleased]

## [0.1.0] — 2026-07-03

First public release.

### Added

- **Design package** — adversarially reviewed architecture: `ARCHITECTURE-REFRAMED.md`
  (source of truth), `STRESS-TEST.md`, `DECISIONS.md` (D1–D10), component specs,
  `BUILD-PLAN.md`, `SECURITY-THREATMODEL.md`, `CONFORMANCE.md` (Agentic Product Standard mapping).
- **Product monorepo** (Bun workspace, TS strict, zero runtime deps): contracts,
  trust-controller (outcome-based autonomy, fast-demote), incident-memory (outcome-weighted
  retrieval, drift-resistant recurrence), aggregation, signal-layer (HMAC-verified ingestion),
  orchestrator (durable kill bit / notify CAS / auto_action ledger), loop-a (RCA copilot, zero
  write access), loop-b (test-suite self-healing discriminator), hitl (approval ladder +
  business-hours gate), pipeline (end-to-end vertical slice), app (deployable signal-intake service).
- **Usable end-to-end**: native **Sentry webhook ingestion** (`@sho/ingest-sentry` — real
  `sentry-hook-signature`, grouping-id fingerprint); a **real git-backed RCA tool** (`@sho/rca-git` —
  deploy-diff/blame/log) that unblocks grounded CONFIRMED verdicts via `RCA_GIT_REPO`; an **operational
  HTTP surface** (`GET /incidents`, `GET /status`, signed `POST /kill|/release`, `POST /telegram/callback`
  for tap-to-ack). Day-2 guide in `USAGE.md`.
- **60-second onboarding**: `bun run demo` (zero-config live walkthrough over real HTTP), `bun run
  migrate` / `send-signal` CLIs, `docker-compose.yml` (Postgres + pgvector + service), demo-first
  README, fresh-clone demo smoke in CI.
- **Ecosystem adapters** — each behind a `@sho/contracts` port with a standalone default, verified
  against the real target: AgenticOps (Telemetry + Backlog), AgenticMind (incident memory over MCP
  contract v1.2.0), AgenticPerformance/APL (OTel-shaped telemetry). See `INTEGRATIONS.md`.
- **Reference kernels** — D10 MTTR instrument (+ CSV/PagerDuty/Linear/Sentry adapters),
  must-fail-on-parent verification gate, mutation-score gate, integrated `verify()` + CI workflow.
- **Live verification** against real Postgres 16 + pgvector: 36 checks (incident-memory path,
  durable orchestrator incl. restart-survival, app end-to-end with durable no-double-notify).
