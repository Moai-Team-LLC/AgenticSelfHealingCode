# Connectors — the open-source boundary

Live integrations (Linear, Sentry) that feed the D10 instrument. **This layer is where credentials
live, so it is where the open-source boundary is drawn:**

- **Committed to the repo:** the pure mappers (`../d10-instrument/adapters/{linear,sentry}.ts`), the
  pull scripts here (`*-pull.ts`), `.env.example`, and this README.
- **Never committed** (`.gitignore`): `connectors/.env` (your keys), and any pulled data
  (`incidents.json`, `*.pulled.json`) — it can contain company-identifying content.

The mappers are pure functions over an API response shape; they hold no secrets and are unit-tested
with fixtures. The pull scripts read credentials **only** from environment (`connectors/.env`) and
never print them.

## Setup (you do the credential steps — the tool never mints or handles raw keys)

```bash
cp connectors/.env.example connectors/.env
# then edit connectors/.env:
#  - Linear: create a Personal API key (Settings → Security & access → Personal API keys), paste it.
#  - map your workflow-state names to the D10 fields (LINEAR_STATE_*).
#  - Sentry (optional): create an org auth token, set org/project.
```

## Pull → analyze

```bash
bun run connectors/linear-pull.ts   # → connectors/incidents.json  (gitignored)
bun run d10-instrument/d10.ts connectors/incidents.json   # the D10 verdict on your real data
```

## The honest caveat this encodes

Linear (like most trackers) records detection/ack/resolve but not *when the root cause was
confirmed* unless your workflow has a state for it (`LINEAR_STATE_CAUSE_CONFIRMED`). Without that
timestamp, D10 cannot separate diagnosis from remediation and will report those incidents as
non-decomposable / low-confidence. That is a true signal, not a defect: add a "Root cause found"
state to your incident workflow and the picture sharpens.

## Publishing to GitHub

Before pushing: confirm `git status` shows **no** `connectors/.env` and **no** `*.pulled.json` /
`incidents.json`. The `.gitignore` covers them, but verify. Rotate any key that was ever pasted
outside `.env`.
