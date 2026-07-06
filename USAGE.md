# Using it for real — connect telemetry, ground RCA, operate

After `docker compose up` you have a running service on `:3000`. This is the day-2 guide: point your
real telemetry at it, turn on grounded diagnosis, and operate it from your phone and shell. Every
capability is an opt-in env var — the service runs without any of them (on fakes).

## 1. Connect your telemetry

### Sentry (native)

The `/webhook/sentry` endpoint speaks Sentry's own webhook format and signature — no shim needed.

1. Sentry → **Settings → Developer Settings → Custom Integrations → New Internal Integration**.
2. Enable **Webhooks**, set the **Webhook URL** to `https://<your-host>/webhook/sentry`, and subscribe
   to the **issue** and **error** alert resources.
3. Copy the integration's **Client Secret** and set it on the service:

```bash
SENTRY_CLIENT_SECRET=<client-secret>   # in connectors/.env or the environment, then restart
```

The service verifies each webhook's `sentry-hook-signature` (HMAC-SHA256 over the raw body) with that
secret, maps the event to an incident (the **issue grouping id** becomes the fingerprint, so recurrences
collapse), and diagnoses it. Recurrences of the same issue don't re-page (durable notify CAS).

### Anything else (OTel, custom, business metrics)

Sources without a native adapter POST the normalized shape to `/webhook/<source>` with an
`x-signature` header = HMAC-SHA256 of the raw body under `SIGNAL_SECRET`. `bun run send-signal` is both
a CLI and a copy-paste reference for how your forwarder should sign:

```bash
SIGNAL_SECRET=<same-as-server> bun run send-signal --url https://<your-host> --file my-signal.json
```

The incident schema (`id`, `fingerprint`, `service`, `affected_paths`, `severity`, `occurrences`,
`recent_deploys`, …) is in `packages/contracts/src/types.ts`.

## 2. Turn on grounded diagnosis

Out of the box the RCA loop has no repo to inspect, so grounding is null and everything **escalates**
with named missing evidence (honest — it never guesses). Two upgrades:

- **`RCA_GIT_REPO=/path/to/a/checkout`** — a local checkout of the monitored service. Now the RCA loop
  reads real deploy diffs (`git diff <range>`), blame, and history: a deploy-linked exception whose
  cited file is in the deploy diff can reach **CONFIRMED** and recommend the rollback. (Read-only git;
  the range is charset-validated and run without a shell.)
- **`ANTHROPIC_API_KEY=…`** — Claude proposes the ranked hypotheses. Its confidence is *ignored*;
  grounding is always the mechanical booleans, never the model's self-report.

Both are optional and independent. Without a repo you still get a useful **enriched alert** (dedup +
hypothesis + delivery); with one you get grounded verdicts.

## 3. Deliver to your on-call (Telegram)

```bash
TELEGRAM_BOT_TOKEN=…      # from @BotFather
TELEGRAM_CHAT_ID=…        # the chat/channel to page
TELEGRAM_WEBHOOK_SECRET=$(openssl rand -hex 16)   # a secret_token for the callback endpoint
```

Delivered why-traces arrive with an inline **ack** button. Wire the button back by registering the
callback endpoint with Telegram (once):

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=https://<your-host>/telegram/callback" \
  -d "secret_token=$TELEGRAM_WEBHOOK_SECRET" \
  -d 'allowed_updates=["callback_query"]'
```

A tap records the human acknowledgement against the incident (visible in `GET /incidents/<id>`) and
answers the callback.

## 4. Operate it

```bash
curl localhost:3000/status              # killed? counts (delivered/escalated/suspicious/acked), adapter modes
curl localhost:3000/incidents?limit=20  # recent incidents, most-recent first
curl localhost:3000/incidents/<id>      # one incident + who acked it
```

**Freeze everything to diagnosis-only** (the kill switch) — a signed action, HMAC over the body under
`SIGNAL_SECRET`:

```bash
S=$SIGNAL_SECRET
sig() { printf '%s' "$1" | openssl dgst -sha256 -hmac "$S" | sed 's/^.* //'; }

BODY='{}';                              curl -X POST localhost:3000/kill    -H "x-signature: $(sig "$BODY")" -d "$BODY"
BODY="{\"token\":\"$KILL_RELEASE_TOKEN\"}"; curl -X POST localhost:3000/release -H "x-signature: $(sig "$BODY")" -d "$BODY"
```

`release` also requires the `KILL_RELEASE_TOKEN` you configured — a stale heartbeat keeps the freeze
(fail-safe). On Postgres the kill state is durable and survives restarts.

## Environment reference

| Var | Effect |
|---|---|
| `SIGNAL_SECRET` | HMAC secret for `/webhook/*` (our format) and signed ops (`/kill`, `/release`). |
| `DATABASE_URL` | Postgres + pgvector → durable state (memory, notify CAS, kill switch, ledger). Run `bun run migrate` first. |
| `SENTRY_CLIENT_SECRET` | Enables native Sentry webhooks on `/webhook/sentry`. |
| `RCA_GIT_REPO` | Local checkout → real git deploy-diff grounding (CONFIRMED, not just ESCALATE). |
| `ANTHROPIC_API_KEY` | Claude proposes RCA hypotheses (grounding stays mechanical). |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Deliver why-traces to on-call. |
| `TELEGRAM_WEBHOOK_SECRET` | Auth for the `/telegram/callback` endpoint. |
| `KILL_RELEASE_TOKEN` | The token required to `release` the kill switch. |
| `GITHUB_WEBHOOK_SECRET` | Enables the `/webhook/github` PR-merge confirm channel (Loop C L1). |
| `GITHUB_TOKEN` / `GITHUB_REPO` | Open the Loop C proposal PR (`pull-requests:write`) against `owner/name`. |
| `PORT` | Listen port (default 3000). |

## 5. Turn on human-confirmed code repair (Loop C, L1)

Optional. When configured, a grounded **CONFIRMED** *code* diagnosis becomes a **proposed pull request** for
a human to merge — never an auto-apply. The proposal is only surfaced *after* it clears the non-LLM gate
(must-fail-on-parent + mutation + no-weakening), so a human reviews a diff that already reproduced the bug and
flipped it green. A human confirms in **either** channel:

- **GitHub PR merge** — merging the PR is the approval. Point a `pull_request` webhook at `/webhook/github`
  (`x-hub-signature-256` verified against `GITHUB_WEBHOOK_SECRET`); on merge SHO records a `human_approved`
  landing (loop C).
- **Telegram** — the proposal notice carries `approve` / `reject` buttons; a tap routes to the same landing.

```bash
GITHUB_WEBHOOK_SECRET=$(openssl rand -hex 16)   # secret set on the GitHub webhook
GITHUB_TOKEN=…                                   # fine-grained token, pull-requests:write (never committed)
GITHUB_REPO=owner/name                           # the monitored repo the PR opens against
```

It **never auto-applies**: fully-autonomous repair (L2/L3) stays deferred, earned per incident-class on
measured outcomes (`TRUST-CONTROLLER.md`). Protected paths — auth, billing, infra, migrations, CI, secrets —
are never touched at any level. The one piece you supply is the **repair worker** (`RepairAuthor`) that authors
the candidate diff inside the sandbox; `@sho/loop-c` ships everything around it (gate, PR channel, approval
ladder, landing) plus in-memory fakes to run the whole loop offline. See
[`LOOP-C-DEFERRED.md`](LOOP-C-DEFERRED.md) §5 and [`SECURITY-THREATMODEL.md`](SECURITY-THREATMODEL.md) §4.

## What this is (and isn't) yet

Today's product: **grounded incident diagnosis → delivery → human ack**, plus **human-confirmed code repair**
(`@sho/loop-c`, L1 — propose → gate → PR/Telegram confirm → `human_approved` landing), test-suite
self-healing (`loop-b`), the verification gates (`gate/`) as CI-side tools, and the D10 instrument for
deciding where to invest. **Autonomous** production-code repair (Loop C L2/L3, no human in the loop) is
deferred by design — earned per incident-class on measured outcomes, never on first contact. See
[`ARCHITECTURE-REFRAMED.md`](ARCHITECTURE-REFRAMED.md) and [`CONFORMANCE.md`](CONFORMANCE.md) for the
full picture and the honest gaps.
