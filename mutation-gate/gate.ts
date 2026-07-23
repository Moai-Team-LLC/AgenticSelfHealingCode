/**
 * Mutation-Score Gate — the "is the suite strong enough" bar (VERIFICATION-GATE.md S5, D4).
 *
 * Line/branch coverage says a line RAN; it says nothing about whether a bug would be CAUGHT. The
 * honest strength bar is mutation score: introduce small mutations into the touched module, run the
 * suite; a mutant the suite fails on is "killed", one it still passes on "survived". A survivor is a
 * behavior the suite does not actually verify. score = killed / total. Below the per-class effective
 * bar (trust_controller.yaml: L1=0.60, L2=0.75, L3=0.80) the class is INELIGIBLE for auto-apply —
 * the permanent squeeze (ARCHITECTURE-ORIGINAL §0.6, STRESS-TEST §1/§6, D4).
 *
 * This file is pure (mutation generation + the score decision), fully unit-tested. The driver that
 * runs the suite against each mutant is ./runner.ts. Minimal by design: string-level operator
 * mutation with string/comment masking — a production gate uses an AST engine (StrykerJS); this is
 * the reference demonstrator of the *gate mechanic*, not a competitor to it.
 */

export interface Mutant {
  id: number
  line: number
  op: string
  source: string // full mutated source of the file
}

// One mutant per operator occurrence. Lookarounds keep compound operators (>=, ++, =>, **) intact.
const MUTATORS: { name: string; re: RegExp; to: string }[] = [
  { name: '+→-', re: /(?<![+])\+(?![+=])/g, to: '-' },
  { name: '*→/', re: /(?<![*/])\*(?![*=/])/g, to: '/' },
  { name: '>→>=', re: /(?<![>=<])>(?![>=])/g, to: '>=' },
  { name: '>→<', re: /(?<![>=<])>(?![>=])/g, to: '<' },
  { name: '<→<=', re: /(?<![<=>])<(?![<=])/g, to: '<=' },
  { name: '<→>', re: /(?<![<=>])<(?![<=])/g, to: '>' },
  { name: '>=→>', re: /(?<![<>=!])>=/g, to: '>' },
  { name: '<=→<', re: /(?<![<>=!])<=/g, to: '<' },
  { name: '&&→||', re: /&&/g, to: '||' },
  { name: '||→&&', re: /\|\|/g, to: '&&' },
  { name: '===→!==', re: /===/g, to: '!==' },
  { name: '!==→===', re: /!==/g, to: '===' },
  { name: 'true→false', re: /\btrue\b/g, to: 'false' },
  { name: 'false→true', re: /\bfalse\b/g, to: 'true' },
]

/** Blank out string literals and line comments so operators inside them are never mutated. */
export function maskLine(line: string): string {
  let out = ''
  let quote = ''
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      out += ' '
      if (c === quote && line[i - 1] !== '\\') quote = ''
      continue
    }
    if (c === '/' && line[i + 1] === '/') return out + ' '.repeat(line.length - i)
    if (c === '"' || c === "'" || c === '`') { quote = c; out += ' '; continue }
    out += c
  }
  return out
}

/**
 * Blank `/* … *​/` block comments across the whole source (length- and
 * line-count-preserving, so mutant line/col stay valid). Without this, operators
 * inside a JSDoc block (`>`, `+`, `&&`, …) are mutated into behaviourally-inert
 * mutants that always survive and silently deflate the score — the bug that made
 * a well-tested file fail its own gate purely from a verbose doc comment.
 */
export function maskBlockComments(src: string): string {
  let out = ''
  let inBlock = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (inBlock) {
      if (c === '*' && src[i + 1] === '/') { out += '  '; i++; inBlock = false; continue }
      out += c === '\n' ? '\n' : ' '
      continue
    }
    if (c === '/' && src[i + 1] === '*') { out += '  '; i++; inBlock = true; continue }
    out += c
  }
  return out
}

/** Generate one mutant per operator occurrence (outside strings/comments). Deterministic order. */
export function mutate(src: string): Mutant[] {
  const lines = src.split('\n')
  // Mask block comments first (cross-line), then strings + line comments per line.
  const masked = maskBlockComments(src).split('\n').map(maskLine)
  const mutants: Mutant[] = []
  let id = 0
  for (const m of MUTATORS) {
    for (let li = 0; li < lines.length; li++) {
      for (const match of masked[li].matchAll(m.re)) {
        const col = match.index!
        const orig = lines[li]
        const mutatedLine = orig.slice(0, col) + m.to + orig.slice(col + match[0].length)
        const copy = [...lines]
        copy[li] = mutatedLine
        mutants.push({ id: id++, line: li + 1, op: m.name, source: copy.join('\n') })
      }
    }
  }
  return mutants
}

// ---- the score decision (pure) --------------------------------------------

export type MutantStatus = 'killed' | 'survived'
export interface MutantResult { id: number; line: number; op: string; status: MutantStatus }

export interface ScoreReport {
  total: number
  killed: number
  survived: number
  score: number | null // killed / total; null when no mutants were generated
  threshold: number
  pass: boolean
  reason: string
  survivors: { line: number; op: string }[]
}

export function scoreGate(results: MutantResult[], threshold: number): ScoreReport {
  const total = results.length
  const killed = results.filter((r) => r.status === 'killed').length
  const survived = total - killed
  const score = total > 0 ? killed / total : null
  const survivors = results.filter((r) => r.status === 'survived').map((r) => ({ line: r.line, op: r.op }))
  let pass = false
  let reason: string
  if (score === null) {
    reason = 'no mutants generated — module has no mutable operators; gate cannot assess strength (treat as INELIGIBLE)'
  } else if (score >= threshold) {
    pass = true
    reason = `mutation score ${score.toFixed(2)} ≥ ${threshold} — suite is strong enough for this level`
  } else {
    reason = `mutation score ${score.toFixed(2)} < ${threshold} — ${survived} surviving mutant(s): behaviors the suite does not verify. Class stays INELIGIBLE for auto-apply (permanent squeeze, D4).`
  }
  return { total, killed, survived, score, threshold, pass, reason, survivors }
}
