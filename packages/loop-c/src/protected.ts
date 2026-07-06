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
  // Dependency manifests + lockfiles (SECURITY-THREATMODEL §4.4 no-new-dependency policy): an autonomous
  // code-repair worker never changes dependencies — a genuine dep change escalates to a human.
  /(^|\/)package\.json$/,
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/,
  /(^|\/)(go\.mod|go\.sum|Cargo\.(toml|lock)|requirements\.txt|Gemfile(\.lock)?|pom\.xml|build\.gradle)$/,
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

/**
 * Extract the file paths a unified diff actually writes — from the `---`/`+++`/`diff --git`/`rename` headers.
 * The protected-path check must run on THESE, not on an author's self-declared `touchedPaths`: a steered or
 * malicious author could declare only benign paths while the diff touches a protected one. (In production the
 * authoritative guard is still the server-side CI path-guard + branch protection, SECURITY §5.2 — this is
 * defense in depth so a protected write never even reaches the gate.)
 */
export function pathsFromUnifiedDiff(diff: string): string[] {
  const paths = new Set<string>()
  const strip = (p: string) => p.replace(/^[ab]\//, '').replace(/\t.*$/, '').trim()
  for (const line of diff.split('\n')) {
    const pm = /^(?:\+\+\+|---) (.+)$/.exec(line)
    if (pm && pm[1]) {
      const p = strip(pm[1])
      if (p && p !== '/dev/null') paths.add(p)
      continue
    }
    const gm = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
    if (gm && gm[1] && gm[2]) {
      paths.add(strip(gm[1]))
      paths.add(strip(gm[2]))
      continue
    }
    const rm = /^rename (?:from|to) (.+)$/.exec(line)
    if (rm && rm[1]) {
      const p = strip(rm[1])
      if (p) paths.add(p)
    }
  }
  return [...paths]
}
