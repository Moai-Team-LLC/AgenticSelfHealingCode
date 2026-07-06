# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/) (pre-1.0: minor bumps may break).

## [Unreleased]

### Added

- **Human-confirmed code repair — Loop C, L1** (`@sho/loop-c`). Activates the rung `LOOP-C-DEFERRED.md` §5.1
  already specified as the v1 behavior ("every Loop C fix is an L1 PR for HITL, propose-only, human-merged,
  never auto-merged") and that the Trust Controller's `effectiveLevel` already bases on ("nothing is auto by
  default"). A grounded **CONFIRMED** *code* diagnosis is authored into a candidate patch, which must clear —
  in order — a **protected-path block** (auth/billing/infra/migrations/CI/secrets, never autonomous), a
  **grounded-repro invariant** (reproduced ∧ flipped-green, observed booleans not self-report), and the
  **non-LLM verification gate** (must-fail-on-parent + mutation + no-weakening) **before any human sees it**.
  Only then is it opened as a PR + an L1 approval; it **never auto-applies**.
- **Two confirm channels, one landing.** A human confirms by **merging the PR** (`POST /webhook/github`,
  `x-hub-signature-256` verified) **or** by **Telegram** approve/reject — both route through a single
  `confirmRepair`, which writes exactly one idempotent `human_approved` loop-C landing (the assisted_action
  the promotion ladder needs, D6). GitHub adapter (`githubPublisher`, `verifyGithubSignature`, `parseMergedPr`)
  is offline-testable via an injected fetch and never holds a key.
- **App wiring** — opt-in `AppDeps.repair`; a `RepairIndex` read-model lets both channels reconstruct the
  confirm inputs. Absent → diagnosis-only (the v1 default). 28 new tests (all propose statuses, gate-before-human,
  confirm idempotency across both channels).
- **Sandboxed repair worker** (`@sho/adapters`) — the pluggable `RepairAuthor`, split so the risky half is
  isolated: `claudeRepairProposer` (LLM → candidate diff + regression test; untrusted-data defensive parse, no
  keys, `claude-opus-4-8`) + `gitWorktreeSandbox` (runs the LOOP-C §4.1 grounded repro cycle in an ephemeral
  git worktree — `execFileSync` argv/no-shell, wall-clock timeout, protected-path pre-check, requires an
  explicit `allowUntrustedExecution` acknowledgment that the SECURITY §4 container is in place) +
  `sandboxedRepairAuthor` composing them + `makeVerifyGate` (drives the real `gate/verify.ts`). A real-git
  fixture test proves the grounded booleans are OBSERVED (fix → green, non-fix → stays red, malformed → decline).
- **Durable landing** — `confirmRepair` is now async and lands to either the in-memory store or
  `PgAutoActionStore`, so a `human_approved` row survives restart (verified live: `verify-loopc-pg.ts`, in CI).

### Security

- **Protected-path check now operates on the diff's ACTUAL paths**, not the author's self-declared
  `touchedPaths` (`pathsFromUnifiedDiff`). A steered/malicious author that under-declares can no longer slip a
  protected write past the in-process guard. (The authoritative guard in production remains the server-side CI
  path-guard + branch protection, SECURITY §5.2; this is defense in depth.) Found by an adversarial red-team audit.
- **Dependency manifests + lockfiles are now protected** (`package.json`, `*-lock.*`, `go.mod`, `Cargo.*`, …)
  — an autonomous code-repair worker never changes dependencies (SECURITY §4.4); a genuine dep change escalates
  to a human. Found by the same audit.

### Fixed

- **`PgAutoActionStore` jsonb hydration** — the driver returns `jsonb` as a string; `gate_result` was cast
  without parsing, so the frozen `GateResult` read back as a string (`.pass` undefined) for every reader of a
  durable landing. Now parsed. Caught by the new live loop-C durability check.

### Note

- Fully **autonomous** repair (Loop C **L2/L3**, no human in the loop) remains deferred by design — earned
  per incident-class on measured outcomes (`TRUST-CONTROLLER.md`), never on first contact. The one piece L1
  needs to run against a live repo is the sandboxed `RepairAuthor` (Claude patch-proposer in the ephemeral,
  egress-denied container, `SECURITY-THREATMODEL.md` §4); `@sho/loop-c` ships the port + fakes and everything
  around it.

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
