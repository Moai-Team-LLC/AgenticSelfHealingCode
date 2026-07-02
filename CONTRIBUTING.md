# Contributing to Self-Healing Ops

Thanks for your interest. SHO is an Apache-2.0 open-source product — a standalone system that also
plugs into [AgenticMind](https://github.com/AlexDuchDev/agenticmind) and AgenticOps (see
[`INTEGRATIONS.md`](INTEGRATIONS.md)).

## Setup

Requires [Bun](https://bun.sh) (≥ 1.3). No `npm install` — the monorepo resolves `@sho/*` packages via
`tsconfig.base.json` paths.

```bash
bun test packages          # the whole product (152 unit tests)
```

Live checks that need Postgres + pgvector (optional; for the DB-backed paths):

```bash
docker run -d --name sho-pg -e POSTGRES_PASSWORD=sho -e POSTGRES_DB=sho -p 54329:5432 pgvector/pgvector:pg16
# apply migrations from @sho/contracts MIGRATIONS via psql, then:
DATABASE_URL=postgres://postgres:sho@localhost:54329/sho bun run packages/incident-memory/verify-pg.ts
DATABASE_URL=… bun run packages/orchestrator/verify-orch-pg.ts
DATABASE_URL=… bun run packages/app/verify-app-pg.ts
```

## Architecture principles (please preserve)

1. **Contracts-first.** All shared types/DDL live in `@sho/contracts`. Never re-declare a shared shape
   in a package — import it. This is what keeps the components interoperable.
2. **Infrastructure behind interfaces.** Postgres, the LLM, Telegram, and the AgenticOps/AgenticMind
   integrations are all adapters behind a port with an in-memory/fake default. Decision logic stays
   pure and unit-tested; the real adapter is thin.
3. **Functions that need "now" take `nowMs` as a parameter** (determinism; no wall-clock in the
   decision path).
4. **Grounded over asserted.** Confidence is observed booleans (did the repro reproduce?), never a
   self-reported LLM number. Trust expands on measured outcomes, not the absence of a veto.
5. **Zero secrets in the repo.** Credentials live only in `connectors/.env` (gitignored). Never commit
   a key or paste one anywhere but `.env`. See `connectors/README.md`.

## Design docs

The design (and the adversarial review that shaped it) is in the root markdown files —
`ARCHITECTURE-REFRAMED.md` is the source of truth, `STRESS-TEST.md` the review, `DECISIONS.md` the
D1–D10 log. Read the relevant spec before changing a component.

## PRs

- Add/adjust tests with any behavior change (Principle 2 of the system also applies to the repo:
  a change should ship its regression test).
- Keep changes surgical; match the surrounding style.
- Conventional Commits for messages.
