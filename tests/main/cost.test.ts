import { describe, it, expect } from 'vitest'
import {
  parseCostLine,
  parseCostLines,
  COST_RAW_CAP,
  DEFAULT_COST_PATTERNS,
  type CostPattern
} from '../../src/main/cost'
import type { Provider } from '../../src/shared/types'

// Fixture summary lines per provider (as they appear AFTER stripAnsi). Each
// entry: the raw text + the figures we expect to parse out.
const FIXTURES: Record<
  Provider,
  { line: string; costUSD?: number; inputTokens?: number; outputTokens?: number }[]
> = {
  claude: [
    {
      line: 'Total cost: $0.1234 (1,200 input, 3,400 output tokens)',
      costUSD: 0.1234,
      inputTokens: 1200,
      outputTokens: 3400
    },
    { line: 'Total cost: $2.50', costUSD: 2.5 },
    { line: 'Tokens: 1,200 in / 3,400 out', inputTokens: 1200, outputTokens: 3400 }
  ],
  codex: [
    { line: 'usage — input 1,200, output 3,400, $0.10', inputTokens: 1200, outputTokens: 3400, costUSD: 0.1 },
    { line: 'tokens used: 12,345 (cost: $0.05)', inputTokens: 12345, costUSD: 0.05 },
    { line: 'tokens used: 500', inputTokens: 500 }
  ],
  gemini: [
    {
      line: 'Estimated cost: $0.02 — prompt 1,200 tokens, response 3,400 tokens',
      costUSD: 0.02,
      inputTokens: 1200,
      outputTokens: 3400
    },
    { line: 'Token usage: prompt=1200 response=3400', inputTokens: 1200, outputTokens: 3400 }
  ]
}

// Lines that must NEVER parse as a cost summary (false-positive guard). These
// are ordinary transcript lines that merely mention money/tokens/usage.
const NON_SUMMARY = [
  'I will estimate the cost of the change before proceeding.',
  'The function tokenizes the input and returns a list.',
  'usage: myprog [--flag] <file>',
  'This costs nothing and uses no tokens.',
  '$ git status',
  'total: done'
]

describe('parseCostLine — per-provider true positives', () => {
  for (const provider of Object.keys(FIXTURES) as Provider[]) {
    for (const f of FIXTURES[provider]) {
      it(`${provider}: parses "${f.line}"`, () => {
        const c = parseCostLine(provider, f.line)
        expect(c).not.toBeNull()
        expect(c!.provider).toBe(provider)
        if (f.costUSD != null) expect(c!.costUSD).toBeCloseTo(f.costUSD, 6)
        else expect(c!.costUSD).toBeUndefined()
        if (f.inputTokens != null) expect(c!.inputTokens).toBe(f.inputTokens)
        if (f.outputTokens != null) expect(c!.outputTokens).toBe(f.outputTokens)
        expect(c!.raw.length).toBeLessThanOrEqual(COST_RAW_CAP)
      })
    }
  }
})

describe('parseCostLine — false positives are rejected', () => {
  for (const provider of Object.keys(FIXTURES) as Provider[]) {
    for (const line of NON_SUMMARY) {
      it(`${provider}: does not match "${line}"`, () => {
        expect(parseCostLine(provider, line)).toBeNull()
      })
    }
  }
})

describe('parseCostLines — last-summary-wins', () => {
  it('returns the LAST matching line across a batch', () => {
    const lines = [
      'Total cost: $0.10 (100 input, 200 output tokens)',
      'some other output',
      'Total cost: $0.40 (400 input, 800 output tokens)'
    ]
    const c = parseCostLines('claude', lines)
    expect(c!.costUSD).toBeCloseTo(0.4, 6)
    expect(c!.inputTokens).toBe(400)
  })

  it('returns null when no line matches (chip shows unknown, never $0)', () => {
    expect(parseCostLines('claude', ['hello', 'world'])).toBeNull()
  })
})

describe('injectable pattern table', () => {
  it('honours a caller-supplied per-provider table', () => {
    const custom: Record<Provider, CostPattern[]> = {
      ...DEFAULT_COST_PATTERNS,
      claude: [{ re: /spent (\d+) credits/i, parse: (m) => ({ inputTokens: Number(m[1]) }) }]
    }
    // default table would not match this line
    expect(parseCostLine('claude', 'spent 42 credits')).toBeNull()
    // injected table does
    const c = parseCostLine('claude', 'spent 42 credits', custom)
    expect(c!.inputTokens).toBe(42)
  })
})

describe('raw cap', () => {
  it('truncates the stored raw summary to the 2KB cap', () => {
    const long = 'Total cost: $1.00 (1 input, 1 output tokens) ' + 'x'.repeat(4000)
    const c = parseCostLine('claude', long)
    expect(c!.raw.length).toBe(COST_RAW_CAP)
  })
})
