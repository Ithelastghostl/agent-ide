import type { AttentionState, CostSummary } from '@shared/types'

/** Format a cost summary for a chip. Prefers the dollar figure; falls back to a
 *  token count. A summary always has at least one figure (the parser rejects
 *  empty matches), so this never renders an empty string. */
export function formatCost(c: CostSummary): string {
  if (c.costUSD != null) return `$${c.costUSD.toFixed(c.costUSD < 1 ? 4 : 2)}`
  const toks = (c.inputTokens ?? 0) + (c.outputTokens ?? 0)
  if (toks > 0) return `${formatTokens(toks)} tok`
  return 'unknown'
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** A per-session cost chip, or undefined when no cost summary exists (chip
 *  HIDDEN — never "$0", item 19). */
export function costChip(c: CostSummary | undefined): HTMLElement | undefined {
  if (!c) return undefined
  const chip = document.createElement('span')
  chip.className = 'cost-chip'
  chip.title = c.raw || 'usage summary'
  chip.textContent = formatCost(c)
  return chip
}

/** An attention badge for a flagged session, or undefined when not flagged. */
export function attentionBadge(state: AttentionState | undefined): HTMLElement | undefined {
  if (!state) return undefined
  const badge = document.createElement('span')
  badge.className = `att-badge ${state}`
  badge.textContent = state === 'input' ? '● needs input' : '● idle'
  badge.title = state === 'input' ? 'This session looks like it is waiting for you' : 'This session has been quiet'
  return badge
}
