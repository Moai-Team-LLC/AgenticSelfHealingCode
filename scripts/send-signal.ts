#!/usr/bin/env bun
/**
 * Sign and send a signal to a running AgenticSelfHealingCode instance — and a copy-paste example of
 * how your telemetry source should sign its webhooks (HMAC-SHA256 over the RAW body, hex, in the
 * x-signature header).
 *
 *   bun run send-signal                                  # built-in sample → http://localhost:3000
 *   bun run send-signal --url http://host:3000 --file signal.json
 *   SIGNAL_SECRET=... bun run send-signal                # must match the server's SIGNAL_SECRET
 */

import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const url = arg('url') ?? 'http://localhost:3000'
const source = arg('source') ?? 'sentry'
const secret = process.env.SIGNAL_SECRET
if (!secret) {
  console.error('SIGNAL_SECRET is not set (must match the server). Example:\n  SIGNAL_SECRET=dev-secret bun run send-signal')
  process.exit(2)
}

const body = arg('file')
  ? readFileSync(arg('file')!, 'utf8')
  : JSON.stringify({
      id: `sig-${Math.random().toString(36).slice(2, 8)}`,
      fingerprint: 'TypeError_checkout_price',
      service: 'checkout',
      severity: 3,
      occurrences: 7,
      affected_paths: ['src/checkout/price.ts'],
      first_seen: new Date().toISOString(),
      shape: 'step',
      title: 'TypeError in checkout',
      message: "cannot read 'id' of undefined",
      error_class: 'TypeError',
      recent_deploys: [{ deploy_id: 'd1', ts: new Date(Date.now() - 1_800_000).toISOString() }],
    })

// The signing contract: HMAC-SHA256 over the raw body, hex digest, x-signature header.
const signature = createHmac('sha256', secret).update(body, 'utf8').digest('hex')

const res = await fetch(`${url}/webhook/${source}`, { method: 'POST', headers: { 'x-signature': signature }, body })
console.log(`POST ${url}/webhook/${source} → HTTP ${res.status}`)
console.log(JSON.stringify(await res.json(), null, 2))
process.exit(res.ok ? 0 : 1)
