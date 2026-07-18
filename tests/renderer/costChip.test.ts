// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { formatCost, costChip, attentionBadge } from '../../src/renderer/components/costChip'
import { AllSessions } from '../../src/renderer/components/AllSessions'
import type { CostSummary, Project, Session } from '@shared/types'

const cost = (over: Partial<CostSummary>): CostSummary => ({
  provider: 'claude',
  updatedAt: 0,
  raw: 'raw',
  ...over
})

describe('formatCost', () => {
  it('prefers dollars, sub-$1 keeps 4 dp', () => {
    expect(formatCost(cost({ costUSD: 0.1234 }))).toBe('$0.1234')
  })
  it('$1+ uses 2 dp', () => {
    expect(formatCost(cost({ costUSD: 2.5 }))).toBe('$2.50')
  })
  it('falls back to a token count when no dollar figure', () => {
    expect(formatCost(cost({ inputTokens: 1200, outputTokens: 3400 }))).toBe('4.6k tok')
  })
})

describe('costChip', () => {
  it('renders a chip with a summary', () => {
    const el = costChip(cost({ costUSD: 0.5 }))!
    expect(el.className).toBe('cost-chip')
    expect(el.textContent).toBe('$0.5000')
  })
  it('is HIDDEN (undefined) when no summary — never $0', () => {
    expect(costChip(undefined)).toBeUndefined()
  })
})

describe('attentionBadge', () => {
  it('renders an input badge', () => {
    const el = attentionBadge('input')!
    expect(el.className).toContain('input')
    expect(el.textContent).toContain('needs input')
  })
  it('renders an idle badge', () => {
    expect(attentionBadge('idle')!.className).toContain('idle')
  })
  it('is undefined when not flagged', () => {
    expect(attentionBadge(null)).toBeUndefined()
    expect(attentionBadge(undefined)).toBeUndefined()
  })
})

describe('AllSessions — attention badges, cost chips, and per-project rollup', () => {
  const projects: Project[] = [
    { id: 'p1', name: 'api', repo: 'e/api', localPath: '/a', hasDevcontainer: false }
  ]
  const sessions: Session[] = [
    {
      id: 's1',
      projectId: 'p1',
      provider: 'claude',
      model: 'opus',
      objective: 'A',
      status: 'running',
      createdAt: 2,
      updatedAt: 2
    },
    {
      id: 's2',
      projectId: 'p1',
      provider: 'codex',
      model: 'gpt',
      objective: 'B',
      status: 'running',
      createdAt: 1,
      updatedAt: 1
    }
  ]

  it('shows badges + chips on rows and a summed dollar rollup on the header', () => {
    const attention = new Map<string, 'input' | 'idle'>([['s1', 'input']])
    const costs = new Map<string, CostSummary>([
      ['s1', cost({ costUSD: 0.1 })],
      ['s2', cost({ provider: 'codex', costUSD: 0.4 })]
    ])
    const el = AllSessions({
      projects,
      sessions,
      attention,
      costs,
      mode: 'live',
      onSetMode: () => {},
      onOpen: () => {}
    })
    expect(el.querySelector('.att-badge.input')).not.toBeNull()
    expect(el.querySelectorAll('.cost-chip').length).toBe(2)
    const rollup = el.querySelector('.as-rollup')!
    expect(rollup.textContent).toBe('Σ $0.5000')
  })

  it('hides the rollup when no session has a dollar figure (never $0)', () => {
    const costs = new Map<string, CostSummary>([['s1', cost({ inputTokens: 100 })]]) // token-only
    const el = AllSessions({ projects, sessions, costs, mode: 'live', onSetMode: () => {}, onOpen: () => {} })
    expect(el.querySelector('.as-rollup')).toBeNull()
    // the token-only chip still renders on the row
    expect(el.querySelectorAll('.cost-chip').length).toBe(1)
  })
})
