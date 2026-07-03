/**
 * Sentry webhook signature verification (Sentry integration-platform contract). Sentry signs the RAW
 * request body with HMAC-SHA256 keyed on the integration's Client Secret and sends the lowercase hex
 * digest in the `sentry-hook-signature` header (a bare hex digest — no `sha256=` algo prefix, unlike
 * GitHub). We recompute and constant-time compare BEFORE the body is parsed: an unverified request
 * never reaches the normalizer (verify-before-normalize). Fail closed on anything missing/malformed.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Constant-time HMAC-SHA256 verification of a raw Sentry webhook body against its
 * `sentry-hook-signature` header, keyed on the integration Client Secret. Returns false (never throws)
 * on empty inputs or a non-hex / wrong-length signature — `Buffer.from(bad,'hex')` silently drops
 * invalid chars, which would desync buffer lengths and make timingSafeEqual throw, so we reject those
 * up front instead of leaking timing on the compare.
 */
export function verifySentrySignature(rawBody: string, signatureHeader: string, clientSecret: string): boolean {
  if (!signatureHeader || !clientSecret) return false
  const provided = signatureHeader.trim()
  const expected = createHmac('sha256', clientSecret).update(rawBody, 'utf8').digest('hex')
  if (provided.length !== expected.length || !/^[0-9a-f]+$/i.test(provided)) return false
  return timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'))
}
