/**
 * Protected-path guard (LOOP-C-DEFERRED.md §3 / §5.3, ARCHITECTURE-REFRAMED §3.4). Tier-4 areas — auth,
 * billing, infra, migrations, CI config, secrets — are NEVER autonomously writable at ANY level; there is
 * no earn-path out (§5.3). In the real deployment this is a required CI path-guard status check plus branch
 * protection, enforced server-side, not by prompt (SECURITY-THREATMODEL §5.2). This predicate applies the
 * SAME policy in-process so a proposed patch touching a protected path is hard-blocked BEFORE the gate and
 * is never surfaced to a human — defense in depth, not a replacement for the server-side check.
 */

const PROTECTED_PATTERNS: readonly RegExp[] = [
  /(^|\/)src\/auth\//, // authentication
  /(^|\/)src\/billing\//, // payments / billing
  /(^|\/)infra\//, // IaC / infrastructure
  /(^|\/)migrations\//, // **/migrations/** — schema DDL
  /(^|\/)\.github\//, // CI config
  /(^|\/)\.env(\.|$)/, // .env, .env.local, …
  /(^|\/)secrets?\//, // secret material dirs
  /\.(pem|key)$/, // key material
]

/** True iff `path` is inside a protected (Tier-4) area. Leading `./` and `/` are normalized away first. */
export function isProtectedPath(path: string): boolean {
  const p = path.replace(/^\.?\//, '')
  return PROTECTED_PATTERNS.some((re) => re.test(p))
}

/** The subset of `paths` that are protected — empty means the whole diff is autonomously proposable. */
export function protectedPathsTouched(paths: readonly string[]): string[] {
  return paths.filter(isProtectedPath)
}
