import type { CostSummary, Provider } from '../shared/types'

/** Raw matched-summary cap (bytes) — mirrors CostSummary.raw ≤2KB (S5, item 19). */
export const COST_RAW_CAP = 2 * 1024

/** A provider cost/usage matcher. `re` runs against a single CLEANED output line
 *  (ANSI already stripped); a match yields the parsed token/dollar figures. The
 *  table is INJECTABLE so tests (and future provider updates) can supply their
 *  own patterns without editing the monitor. */
export interface CostPattern {
  re: RegExp
  /** Pull figures out of a successful match. Return {} for a raw-only summary. */
  parse: (m: RegExpMatchArray) => { inputTokens?: number; outputTokens?: number; costUSD?: number }
}

/** Parse a number that may carry thousands separators ("1,234" → 1234). */
function num(s: string | undefined): number | undefined {
  if (s == null) return undefined
  const n = Number(s.replace(/,/g, ''))
  return Number.isFinite(n) ? n : undefined
}

/** Default per-provider pattern table. Each provider prints a usage/cost summary
 *  line near the end of a turn; we match the LAST such line (last-summary-wins).
 *  These are deliberately tolerant (case-insensitive, flexible separators) so a
 *  minor CLI wording change still matches; an unmatched provider yields no
 *  summary at all (chip shows "unknown", never $0 — item 19). */
export const DEFAULT_COST_PATTERNS: Record<Provider, CostPattern[]> = {
  claude: [
    // "Total cost: $0.1234 (1,200 input, 3,400 output tokens)"
    {
      re: /total cost:?\s*\$\s*([0-9][0-9,]*\.?[0-9]*)(?:.*?([0-9][0-9,]*)\s*input.*?([0-9][0-9,]*)\s*output)?/i,
      parse: (m) => ({ costUSD: num(m[1]), inputTokens: num(m[2]), outputTokens: num(m[3]) })
    },
    // "Tokens: 1,200 in / 3,400 out" (no dollar figure)
    {
      re: /tokens:?\s*([0-9][0-9,]*)\s*(?:in|input)\b.*?([0-9][0-9,]*)\s*(?:out|output)\b/i,
      parse: (m) => ({ inputTokens: num(m[1]), outputTokens: num(m[2]) })
    }
  ],
  codex: [
    // "usage — input 1,200, output 3,400, $0.10"
    {
      re: /usage\b.*?input\s*([0-9][0-9,]*).*?output\s*([0-9][0-9,]*)(?:.*?\$\s*([0-9][0-9,]*\.?[0-9]*))?/i,
      parse: (m) => ({ inputTokens: num(m[1]), outputTokens: num(m[2]), costUSD: num(m[3]) })
    },
    // "tokens used: 12,345 (cost: $0.05)"
    {
      re: /tokens?\s*used:?\s*([0-9][0-9,]*)(?:.*?cost:?\s*\$\s*([0-9][0-9,]*\.?[0-9]*))?/i,
      parse: (m) => ({ inputTokens: num(m[1]), costUSD: num(m[2]) })
    }
  ],
  gemini: [
    // "Estimated cost: $0.02 — prompt 1,200 tokens, response 3,400 tokens"
    {
      re: /(?:estimated\s*)?cost:?\s*\$\s*([0-9][0-9,]*\.?[0-9]*)(?:.*?prompt\s*([0-9][0-9,]*).*?response\s*([0-9][0-9,]*))?/i,
      parse: (m) => ({ costUSD: num(m[1]), inputTokens: num(m[2]), outputTokens: num(m[3]) })
    },
    // "Token usage: prompt=1200 response=3400"
    {
      re: /token\s*usage:?\s*prompt\s*=\s*([0-9][0-9,]*)\s*response\s*=\s*([0-9][0-9,]*)/i,
      parse: (m) => ({ inputTokens: num(m[1]), outputTokens: num(m[2]) })
    }
  ]
}

/** Match ONE cleaned line against a provider's patterns. Returns a partial
 *  CostSummary (provider + updatedAt + raw filled in here) or null when no
 *  pattern matches. The FIRST matching pattern wins for a given line; the caller
 *  keeps the LAST matching line across a turn (last-summary-wins). */
export function parseCostLine(
  provider: Provider,
  line: string,
  patterns: Record<Provider, CostPattern[]> = DEFAULT_COST_PATTERNS
): CostSummary | null {
  const table = patterns[provider]
  if (!table) return null
  for (const p of table) {
    const m = line.match(p.re)
    if (!m) continue
    const fig = p.parse(m)
    // A match with NO usable figure is not a real summary — skip it so a bare
    // word like "cost" never produces an empty (misleading) chip.
    if (fig.inputTokens == null && fig.outputTokens == null && fig.costUSD == null) continue
    return {
      ...fig,
      provider,
      updatedAt: Date.now(),
      raw: line.slice(0, COST_RAW_CAP)
    }
  }
  return null
}

/** Scan a batch of cleaned lines and return the LAST summary found (or null).
 *  Used by the attention/cost monitor which feeds completed lines as they close. */
export function parseCostLines(
  provider: Provider,
  lines: string[],
  patterns: Record<Provider, CostPattern[]> = DEFAULT_COST_PATTERNS
): CostSummary | null {
  let last: CostSummary | null = null
  for (const line of lines) {
    const hit = parseCostLine(provider, line, patterns)
    if (hit) last = hit
  }
  return last
}
