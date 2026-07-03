/**
 * @sho/ingest-sentry — native ingestion of REAL Sentry webhooks. Closes the #1 adoption gap: a stock
 * Sentry integration signs with `sentry-hook-signature` (HMAC-SHA256 of the raw body, keyed on the
 * Client Secret) and ships its own error/issue/event_alert JSON — this package verifies that signature
 * and maps the payload onto the shared @sho/contracts IncidentCandidate. Zero deps, pure + node:crypto.
 */

export { verifySentrySignature } from './verify'
export { sentryWebhookToCandidate } from './map'
export { ingestSentry, type IngestSentryResult } from './ingest'
