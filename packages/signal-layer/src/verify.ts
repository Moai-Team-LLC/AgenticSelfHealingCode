/**
 * Signed-ingestion boundary (SECURITY-THREATMODEL.md §2.1, D7). Webhook sources sign the RAW body with
 * an HMAC-SHA256 keyed on a per-source secret; we recompute it and constant-time compare BEFORE the
 * payload is parsed or normalized. Reject on missing/invalid — never "warn and proceed". This is the
 * structural defense against signal spoofing: an unverified request never reaches the normalizer.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

/** Strip the provider's `sha256=`/`hmac-sha256=` algo prefix if present (GitHub/Sentry style). */
function stripAlgoPrefix(sig: string): string {
  const eq = sig.indexOf('=')
  if (eq > 0 && /^[a-z0-9-]+$/i.test(sig.slice(0, eq))) return sig.slice(eq + 1)
  return sig
}

/**
 * Constant-time HMAC-SHA256 verification of a raw body against a signature header. Accepts a bare hex
 * digest or a `sha256=<hex>` prefixed one. Returns false (never throws) on any malformed/mismatched
 * input — length-mismatched or non-hex signatures fail closed without leaking timing on the compare.
 */
export function verifyHmac(rawBody: string, signatureHeader: string, secret: string): boolean {
  if (!signatureHeader || !secret) return false
  const provided = stripAlgoPrefix(signatureHeader.trim())
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
  // Reject non-hex / wrong-length signatures up front: Buffer.from(..,'hex') silently drops bad chars,
  // which would desync buffer lengths and make timingSafeEqual throw. Fail closed instead.
  if (provided.length !== expected.length || !/^[0-9a-f]+$/i.test(provided)) return false
  return timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'))
}
