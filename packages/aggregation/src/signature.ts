/**
 * Stable identity keys for an incident candidate (ARCH-ORIG §3). Two keys, two jobs:
 *   - fingerprint: exact-ish identity over source + affected paths + a normalized slice of the raw
 *     stack/location. Same bug → same fingerprint; a file rename shifts it (paths changed).
 *   - symptomSignature: the RENAME-PROOF recurrence key — module_area (dir at depth 2) + a normalized
 *     error class/message, deliberately NOT tied to exact file names. It's the drift fallback so a bug
 *     that moves files still recurs onto the same class.
 * Deterministic and dependency-free: hashing is a small stable string hash (Bun.hash when present).
 */

import type { IncidentCandidate } from '@sho/contracts'

/** Stable 64-bit-ish string hash, hex. Uses Bun.hash if available, else a pure FNV-1a fallback. */
export function stableHash(s: string): string {
  const bun = (globalThis as { Bun?: { hash(input: string): bigint | number } }).Bun
  if (bun && typeof bun.hash === 'function') return BigInt(bun.hash(s)).toString(16)
  // FNV-1a 64-bit, pure and deterministic.
  let h = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (let i = 0; i < s.length; i++) {
    h = (h ^ BigInt(s.charCodeAt(i))) & mask
    h = (h * prime) & mask
  }
  return h.toString(16)
}

/** Lowercase, collapse whitespace, strip trailing punctuation. Used before hashing free text. */
export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.:;,]+$/, '')
}

/**
 * Module area = the directory at depth 2 of the first affected path (e.g. `src/auth/login.ts` →
 * `src/auth`). Rename-proof-ish: renaming a file inside a module keeps the area. Falls back to the
 * affected_service when there are no paths.
 */
export function moduleArea(candidate: IncidentCandidate): string {
  const first = candidate.affected_paths[0]
  if (!first) return candidate.affected_service || 'unknown'
  const segs = first.split('/').filter(Boolean)
  if (segs.length <= 1) return segs[0] ?? (candidate.affected_service || 'unknown')
  return segs.slice(0, 2).join('/')
}

/**
 * Pull a normalized error class/message out of raw_payload, WITHOUT trusting or executing any of it
 * (D7 — telemetry text is data). Reads only well-known string fields; ignores everything else. Never
 * includes file paths or line numbers, so it survives a rename.
 */
export function errorSignature(candidate: IncidentCandidate): string {
  const p = (candidate.raw_payload && typeof candidate.raw_payload === 'object'
    ? candidate.raw_payload
    : {}) as Record<string, unknown>
  const cls = typeof p.error_class === 'string' ? p.error_class : typeof p.type === 'string' ? p.type : ''
  const msg = typeof p.message === 'string' ? p.message : typeof p.title === 'string' ? p.title : ''
  // Strip volatile bits from the message so the same bug reads the same: hex/ids, numbers, quoted vals.
  const scrubbed = msg
    .replace(/0x[0-9a-f]+/gi, '<hex>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\d+/g, '<n>')
    .replace(/'[^']*'|"[^"]*"/g, '<v>')
  return normalizeText(`${cls} ${scrubbed}`)
}

/**
 * The raw stack/location slice fed into the fingerprint. Uses the FIRST frame's file:line when the
 * payload carries a structured stack, else falls back to the scrubbed message. Path-sensitive on
 * purpose — this is the exact-identity key, so a rename SHOULD move it.
 */
function locationSlice(candidate: IncidentCandidate): string {
  const p = (candidate.raw_payload && typeof candidate.raw_payload === 'object'
    ? candidate.raw_payload
    : {}) as Record<string, unknown>
  const stack = Array.isArray(p.stack) ? p.stack : undefined
  if (stack && stack.length) {
    const top = stack[0]
    if (top && typeof top === 'object') {
      const f = top as Record<string, unknown>
      const file = typeof f.file === 'string' ? f.file : ''
      const line = typeof f.line === 'number' ? f.line : ''
      const fn = typeof f.function === 'string' ? f.function : ''
      return normalizeText(`${file}:${line}:${fn}`)
    }
    if (typeof top === 'string') return normalizeText(top)
  }
  if (typeof p.culprit === 'string') return normalizeText(p.culprit)
  return errorSignature(candidate)
}

/**
 * fingerprint — exact-ish identity: source + sorted affected paths + normalized stack/location. Same
 * stack → same fingerprint; changing a file path (rename) changes it.
 */
export function fingerprint(candidate: IncidentCandidate): string {
  const paths = [...candidate.affected_paths].map((p) => p.toLowerCase()).sort()
  const key = [candidate.source, paths.join('|'), locationSlice(candidate)].join('␟')
  return stableHash(key)
}

/**
 * symptomSignature — rename-proof recurrence key: module_area + normalized error class/message. Does
 * NOT include exact file names, so a bug that moves files keeps the same signature (drift fallback).
 */
export function symptomSignature(candidate: IncidentCandidate): string {
  const key = [moduleArea(candidate), errorSignature(candidate)].join('␟')
  return stableHash(key)
}
