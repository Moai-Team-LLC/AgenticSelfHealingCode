/**
 * Default injected similarity: deterministic token-overlap (Jaccard). Stands in for the pgvector cosine
 * of the real adapter so retrieval logic is testable with no embedding model. Callers inject their own
 * SimilarityFn to swap in true cosine over the `signal` embedding (§3).
 */

import type { SimilarityFn } from './types'

const tokens = (s: string): Set<string> =>
  new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter(Boolean),
  )

/** Jaccard token overlap in [0,1]. Empty-vs-empty is 0 (no evidence of similarity). */
export const tokenOverlap: SimilarityFn = (query, candidate) => {
  const a = tokens(query)
  const b = tokens(candidate)
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}
