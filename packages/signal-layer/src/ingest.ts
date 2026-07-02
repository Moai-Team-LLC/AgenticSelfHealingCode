/**
 * Authenticated ingestion + normalization (SECURITY-THREATMODEL.md §2, D7). The single edge entry: a
 * raw request body from an attacker-reachable endpoint becomes a typed IncidentCandidate — or a clean
 * rejection. Order is load-bearing:
 *   1. if a secret+signature are supplied, verify the HMAC over the RAW body FIRST and reject on fail —
 *      an unverified request must never reach the normalizer (verify-before-normalize, §2.1);
 *   2. parse the body safely (malformed JSON is a rejection, never a throw);
 *   3. normalize with the shared contract, which also flags log-borne prompt-injection.
 * `suspicious` is surfaced (never acted on): telemetry text is data, not instructions (§3.2).
 */

import { normalizeIncidentCandidate, type IncidentCandidate, type SignalSource } from '@sho/contracts'
import { verifyHmac } from './verify'

export interface IngestOpts {
  secret?: string
  signature?: string
}

export type IngestResult =
  | { ok: true; candidate: IncidentCandidate; suspicious: boolean }
  | { ok: false; reason: string }

function parseJson(rawBody: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(rawBody) }
  } catch {
    return { ok: false }
  }
}

/**
 * Ingest one raw signal from `source`. When both a secret and signature are provided, HMAC is required
 * to pass (attacker-reachable boundary); when neither is provided the body is trusted transport-side
 * (e.g. mTLS internal metrics) and only normalized. A half-supplied pair (one without the other) is
 * treated as a failed authentication attempt and rejected — no silent downgrade.
 */
export function ingest(rawBody: string, source: SignalSource, opts: IngestOpts = {}): IngestResult {
  const { secret, signature } = opts
  const hasSecret = secret !== undefined
  const hasSig = signature !== undefined
  if (hasSecret !== hasSig) return { ok: false, reason: 'incomplete_signature' }
  if (hasSecret && hasSig && !verifyHmac(rawBody, signature, secret)) {
    return { ok: false, reason: 'bad_signature' }
  }

  const parsed = parseJson(rawBody)
  if (!parsed.ok) return { ok: false, reason: 'malformed_json' }

  const { candidate, suspicious } = normalizeIncidentCandidate(parsed.value, source)
  return { ok: true, candidate, suspicious }
}
