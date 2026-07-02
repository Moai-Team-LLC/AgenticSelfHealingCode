<!-- One topic per PR. -->

## What changed

<!-- A sentence or two. -->

## Why

<!-- What's broken or missing today, and why this fixes it. -->

## Checklist

- [ ] `bun test packages` passes locally (plus the affected kernel suites)
- [ ] Added or updated tests for any behavior change (a fix ships its regression test — Principle 2)
- [ ] Shared types/DDL live in `@sho/contracts` only (nothing re-declared in a package)
- [ ] Infrastructure stays behind a port with an in-repo default (adapters are thin and injected)
- [ ] No secrets anywhere; credentials only via `connectors/.env` (gitignored)
- [ ] Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
