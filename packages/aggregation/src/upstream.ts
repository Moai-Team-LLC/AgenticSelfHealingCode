/**
 * Deterministic classification of UPSTREAM/provider failures from the error text — grounded on the actual
 * signal, never an LLM guess. The RCA copilot (Loop A) hypothesizes causes for CODE incidents; but a provider
 * returning 402/429/401/5xx is not a code bug (it is the "config/capacity/upstream" class that stays Loop A
 * forever, LOOP-C-DEFERRED §6). For those, a regex over the ingested error names the cause crisply — e.g.
 * "OpenRouter credit exhausted (402)" instead of the model guessing "transient outage or rate limit".
 *
 * `actionable` splits the classes that need a human to DO something (billing → top up; auth → fix the key)
 * from the transient ones that self-resolve (rate limit, provider blip) — the paging layer uses it to page the
 * former even on a single occurrence, and to stay quiet on a one-off of the latter.
 *
 * This is only as good as what the forwarder ingests: include the upstream status code + error body in the
 * signal (title/message/raw) and this names the cause; omit it and it falls back to null (the LLM hypothesis).
 */

export type UpstreamClass = 'billing' | 'auth' | 'rate_limit' | 'provider_outage'

export interface UpstreamDiagnosis {
  cls: UpstreamClass
  cause: string // crisp one-liner naming the problem
  action: string // what a human should do (or that it is transient)
  actionable: boolean // billing/auth need action; rate_limit/outage are transient/self-resolving
}

const RULES: { cls: UpstreamClass; actionable: boolean; re: RegExp; cause: string; action: string }[] = [
  {
    cls: 'billing', actionable: true,
    re: /\b402\b|insufficient[ _-]?(?:credit|fund|balance|quota)|(?:out of|no|low) (?:credit|fund|balance)|quota (?:exceeded|reached)|payment required|billing (?:issue|error|failure)|credits?\b.{0,12}(?:exhausted|depleted|ran out)|top[ _-]?up/i,
    cause: 'credit/quota exhausted (upstream billing)',
    action: 'top up the provider balance — this will not self-resolve',
  },
  {
    cls: 'auth', actionable: true,
    re: /\b401\b|\b403\b|unauthor|invalid[ _-]?api[ _-]?key|forbidden|authentication failed|permission denied|invalid[ _-]?(?:token|key|credential)/i,
    cause: 'auth rejected — bad/expired key or access (upstream)',
    action: 'rotate or fix the provider API key / permissions',
  },
  {
    cls: 'rate_limit', actionable: false,
    re: /\b429\b|rate[ _-]?limit|too many requests|throttl/i,
    cause: 'rate-limited (upstream)',
    action: 'transient — back off; raise the provider limit if it persists',
  },
  {
    cls: 'provider_outage', actionable: false,
    re: /\b5\d\d\b|timed?[ _-]?out|timeout|econnre[a-z]+|unavailable|bad gateway|service unavailable|upstream (?:error|failure)|gateway timeout|provider.{0,20}(?:down|outage)/i,
    cause: 'provider error/outage (upstream)',
    action: 'transient — provider-side; watch for recurrence',
  },
]

/** Classify an upstream failure from arbitrary signal text; null when nothing recognizable matched. */
export function classifyUpstream(text: string): UpstreamDiagnosis | null {
  for (const r of RULES) {
    if (r.re.test(text)) return { cls: r.cls, cause: r.cause, action: r.action, actionable: r.actionable }
  }
  return null
}
