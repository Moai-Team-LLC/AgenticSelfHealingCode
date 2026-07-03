/**
 * Native Sentry ingestion boundary. The single edge entry for a REAL Sentry webhook: a raw request
 * body + its `sentry-hook-signature` become a typed IncidentCandidate — or a clean rejection. Order is
 * load-bearing (mirrors the signal-layer boundary):
 *   1. verify the HMAC over the RAW body FIRST and reject on fail — an unverified request must never
 *      reach the parser/normalizer;
 *   2. parse the body safely (malformed JSON is a rejection, never a throw);
 *   3. map the Sentry shape → RAW candidate, then normalize with the shared contract (source 'sentry'),
 *      which also flags log-borne prompt-injection.
 * `suspicious` is surfaced (never acted on): telemetry text is data, not instructions.
 */

import { normalizeIncidentCandidate, type IncidentCandidate } from '@sho/contracts'
import { verifySentrySignature } from './verify'
import { sentryWebhookToCandidate } from './map'

export type IngestSentryResult =
  | { ok: true; candidate: IncidentCandidate; suspicious: boolean }
  | { ok: false; reason: string }

/**
 * Ingest one raw Sentry webhook. `signatureHeader` is the `sentry-hook-resource`-carrying request's
 * `sentry-hook-signature`; `clientSecret` is the integration Client Secret. `resource` (the
 * `sentry-hook-resource` header) is advisory metadata passed to the mapper.
 */
export function ingestSentry(
  rawBody: string,
  signatureHeader: string,
  clientSecret: string,
  resource?: string,
): IngestSentryResult {
  if (!verifySentrySignature(rawBody, signatureHeader, clientSecret)) {
    return { ok: false, reason: 'bad_signature' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return { ok: false, reason: 'malformed_json' }
  }

  const mapped = sentryWebhookToCandidate(parsed, { resource })
  const { candidate, suspicious } = normalizeIncidentCandidate(mapped, 'sentry')
  return { ok: true, candidate, suspicious }
}
