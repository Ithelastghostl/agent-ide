// Tool ALLOWLIST for the Linear MCP client (S2, C-16). Only a small, explicit
// set of capabilities is ever invoked: list/search issues, get an issue, update
// an issue's state, and create a comment. A discovered tool is admitted ONLY if
// (a) its name matches the intent's pattern AND (b) its input schema declares the
// fields the intent needs. This is pure + unit-tested; the client never calls a
// tool the allowlist did not resolve.

import type { McpTool } from './mcpClient'

/** The intents S2 needs. Each maps to a name pattern + required-arg predicate. */
export type LinearIntent = 'list-issues' | 'get-issue' | 'update-state' | 'create-comment'

interface IntentSpec {
  /** Ordered name patterns; earlier = stronger preference. */
  patterns: RegExp[]
  /** Property names the tool's inputSchema must plausibly expose (any-of groups). */
  requires: string[][]
  /** Names that DISQUALIFY a tool (avoid mismatching e.g. delete/create issue). */
  forbid?: RegExp[]
}

const SPECS: Record<LinearIntent, IntentSpec> = {
  'list-issues': {
    patterns: [/^list[_-]?issues$/i, /^search[_-]?issues$/i, /issues?$/i],
    requires: [], // listing needs no required arg
    forbid: [/comment|create|update|delete|attachment/i]
  },
  'get-issue': {
    patterns: [/^get[_-]?issue$/i, /^issue$/i],
    requires: [['id', 'issueId', 'issue_id', 'identifier']],
    forbid: [/list|search|comment|create|update|delete/i]
  },
  'update-state': {
    patterns: [/^update[_-]?issue([_-]?state)?$/i, /update.*state/i, /^update[_-]?issue$/i],
    requires: [
      ['id', 'issueId', 'issue_id'],
      ['state', 'stateId', 'state_id', 'status', 'workflowState', 'stateName']
    ],
    forbid: [/comment|create|delete|list|search|attachment/i]
  },
  'create-comment': {
    patterns: [/^create[_-]?comment$/i, /comment/i],
    requires: [['body', 'comment', 'text', 'content']],
    forbid: [/delete|list|update[_-]?issue|search/i]
  }
}

/** Schema property names available on a tool (top-level inputSchema.properties). */
function toolProps(tool: McpTool): Set<string> {
  const props = tool.inputSchema?.properties
  if (!props || typeof props !== 'object') return new Set()
  return new Set(Object.keys(props))
}

/** Does the tool's schema satisfy every required any-of group for the intent? */
function schemaSatisfies(tool: McpTool, requires: string[][]): boolean {
  if (requires.length === 0) return true
  const props = toolProps(tool)
  // If the tool declares NO schema properties at all, accept only when the intent
  // has no requirements (handled above) — otherwise reject (can't validate args).
  if (props.size === 0) return false
  return requires.every((group) => group.some((name) => props.has(name)))
}

/** Resolve the single best-matching allowed tool for an intent, or null. Pure. */
export function resolveTool(tools: McpTool[], intent: LinearIntent): McpTool | null {
  const spec = SPECS[intent]
  const candidates = tools.filter((t) => {
    const name = t.name ?? ''
    if (spec.forbid?.some((f) => f.test(name))) return false
    if (!spec.patterns.some((p) => p.test(name))) return false
    return schemaSatisfies(t, spec.requires)
  })
  if (candidates.length === 0) return null
  // Prefer the earliest-matching pattern (most specific name), then shortest name.
  candidates.sort((a, b) => {
    const ra = spec.patterns.findIndex((p) => p.test(a.name))
    const rb = spec.patterns.findIndex((p) => p.test(b.name))
    if (ra !== rb) return ra - rb
    return a.name.length - b.name.length
  })
  return candidates[0]
}

/** Resolve all four intents against a discovered tool list. A missing intent is
 *  null (the caller surfaces a typed error rather than calling a wrong tool). */
export function resolveAllowedTools(tools: McpTool[]): Record<LinearIntent, McpTool | null> {
  return {
    'list-issues': resolveTool(tools, 'list-issues'),
    'get-issue': resolveTool(tools, 'get-issue'),
    'update-state': resolveTool(tools, 'update-state'),
    'create-comment': resolveTool(tools, 'create-comment')
  }
}

/** Pick the schema arg name a tool uses for a logical field, from a preference
 *  list — so we send `issueId` vs `id` etc. matching the actual schema. Pure. */
export function argNameFor(tool: McpTool, candidates: string[]): string | null {
  const props = toolProps(tool)
  for (const c of candidates) if (props.has(c)) return c
  // Fall back to the first candidate if the tool declared no schema at all.
  return props.size === 0 ? candidates[0] : null
}
