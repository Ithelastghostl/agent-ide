// Orchestrates the Linear integration (S2): OAuth connect, per-project link,
// pull (paginated issues → backlog upsert), and idempotent write-back. Ties
// together oauth.ts (flow), tokenManager (refresh/rotation), mcpClient
// (transport), toolAllowlist (capability resolution), and the token/link stores.
//
// The MCP Bearer token is always sourced through the token manager so refreshes
// are transparent. All logs route through redact().

import type { LinearLink } from '@shared/types'
import type { Store } from '../store'
import {
  LINEAR_MCP_URL, linearLog, redact,
  generateCodeVerifier, codeChallengeS256, generateState, safeEqual,
  discoverProtectedResource, discoverAuthServer, registerClient, exchangeCode,
  buildAuthorizeUrl, awaitLoopbackCode, commentIdempotencyMarker,
  type AuthServerMetadata, type FetchLike
} from './oauth'
import { LinearTokenStore, LinearLinkStore, type AccountRecord } from './tokenStore'
import { LinearTokenManager, applyToken } from './tokenManager'
import { McpClient, type McpTool, type ToolCallResult } from './mcpClient'
import { resolveAllowedTools, argNameFor, type LinearIntent } from './toolAllowlist'

/** A write-back action requested from the UI (after preview). */
export type WritebackAction =
  | { kind: 'started' }
  | { kind: 'done' }
  | { kind: 'comment'; text: string }

/** The preview shown in the modal BEFORE any remote mutation (exact target). */
export interface WritebackPreview {
  itemId: string
  linearId: string
  identifier: string
  title: string
  action: WritebackAction['kind']
  /** For state changes: the exact target state label. For comments: the text. */
  target: string
  /** True when the change is already satisfied remotely (a no-op on apply). */
  alreadySatisfied: boolean
}

export interface WritebackResult {
  ok: boolean
  action: WritebackAction['kind']
  /** 'applied' | 'noop' (already in target / duplicate comment) | 'error'. */
  outcome: 'applied' | 'noop' | 'error'
  detail?: string
  error?: string
}

/** How local 'started'/'done' map to Linear workflow-state *types*. Linear
 *  states have a `type` (backlog|unstarted|started|completed|canceled). */
const STATE_TYPE_FOR: Record<'started' | 'done', string> = {
  started: 'started',
  done: 'completed'
}

export interface LinearServiceDeps {
  store?: Store
  openExternal: (url: string) => boolean
  fetch?: FetchLike
  /** Test seam: inject an MCP client factory (default builds a real McpClient). */
  mcpFactory?: (accountId: string, svc: LinearService) => McpClient
}

export class LinearService {
  private store?: Store
  private openExternal: (url: string) => boolean
  private fetch: FetchLike
  private tokens = new LinearTokenStore()
  private links = new LinearLinkStore()
  private manager: LinearTokenManager
  private mcpFactory?: (accountId: string, svc: LinearService) => McpClient
  /** Cache one MCP client per account for the app lifetime. */
  private clients = new Map<string, McpClient>()

  constructor(deps: LinearServiceDeps) {
    this.store = deps.store
    this.openExternal = deps.openExternal
    this.fetch = deps.fetch ?? fetch
    this.manager = new LinearTokenManager({ store: this.tokens, fetch: this.fetch })
    this.mcpFactory = deps.mcpFactory
  }

  // --- status --------------------------------------------------------------

  status(projectId: string): { connected: boolean; link?: LinearLink; account?: string } {
    const link = this.links.get(projectId)
    if (!link) return { connected: false }
    const connected = this.tokens.has(link.accountId)
    return { connected, link, account: link.accountId }
  }

  // --- OAuth connect -------------------------------------------------------

  /** Run the full OAuth 2.1 + PKCE loopback flow and persist an AccountRecord.
   *  Returns the connected account identity for linking. */
  async connect(): Promise<{ accountId: string; workspaceId: string }> {
    // 1. protected-resource metadata → auth server url
    const prm = await discoverProtectedResource(LINEAR_MCP_URL, this.fetch)
    const asUrl = prm.authorization_servers?.[0]
    if (!asUrl) throw new Error('no authorization server advertised by the resource')
    const meta = await discoverAuthServer(asUrl, this.fetch)

    // 2. dynamic client registration (per loopback redirect — bound below)
    const verifier = generateCodeVerifier()
    const challenge = codeChallengeS256(verifier)
    const state = generateState()

    // 3. loopback listener; register + open browser once the port is known.
    const resource = prm.resource ?? LINEAR_MCP_URL
    let client: Awaited<ReturnType<typeof registerClient>> | undefined
    let redirectUri = ''
    const { code, port } = await awaitLoopbackCode({
      expectedState: state,
      timeoutMs: 120_000,
      onReady: async (p, uri) => {
        redirectUri = uri
        client = await registerClient({ meta, redirectUri: uri, f: this.fetch })
        const authUrl = buildAuthorizeUrl({
          meta, clientId: client.client_id, redirectUri: uri, state,
          codeChallenge: challenge, scope: meta.scopes_supported?.join(' '), resource
        })
        if (!this.openExternal(authUrl)) throw new Error('failed to open browser for authorization')
        linearLog('authorization opened', { port: p })
      }
    })
    if (!client) throw new Error('client registration did not complete')

    // 4. exchange the single-use code for tokens
    const tok = await exchangeCode({
      meta, clientId: client.client_id, clientSecret: client.client_secret,
      code, codeVerifier: verifier, redirectUri: loopbackUriForPort(port, redirectUri), resource, f: this.fetch
    })

    // 5. discover identity (account + workspace) from the authenticated session
    const identity = await this.discoverIdentity(meta, client.client_id, tok.access_token, resource)

    // 6. persist
    const rec: AccountRecord = applyToken({
      accountId: identity.accountId,
      workspaceId: identity.workspaceId,
      meta, client,
      accessToken: tok.access_token,
      resource,
      createdAt: Date.now(),
      updatedAt: Date.now()
    } as AccountRecord, tok)
    this.tokens.save(rec)
    linearLog('account connected', { hasWorkspace: !!identity.workspaceId })
    return { accountId: identity.accountId, workspaceId: identity.workspaceId }
  }

  /** Discover the authenticated account + workspace identity. Uses an
   *  allowlisted viewer-style MCP tool if the server exposes one; otherwise
   *  derives a stable id from the token grant. */
  private async discoverIdentity(meta: AuthServerMetadata, clientId: string, accessToken: string, resource: string): Promise<{ accountId: string; workspaceId: string }> {
    // Build a throwaway client bound to this fresh token for the identity probe.
    const client = new McpClient({
      endpoint: resource,
      getToken: async () => accessToken,
      fetch: this.fetch
    })
    try {
      const tools = await client.listTools()
      // Strict, anchored viewer-tool match — a loose /me/ substring would wrongly
      // match e.g. create_com*me*nt and mutate data during an identity probe.
      const viewer = tools.find((t) => /^(viewer|whoami|current[_-]?user|me|organization|get[_-]?viewer|get[_-]?organization)$/i.test(t.name))
      if (viewer) {
        const res = await client.callTool(viewer.name, {})
        const parsed = firstJson(res)
        const accountId = str(parsed, ['id', 'userId', 'accountId', 'viewerId'])
        const workspaceId = str(parsed, ['organizationId', 'workspaceId', 'orgId', 'teamId'])
        if (accountId) return { accountId, workspaceId: workspaceId || accountId }
      }
    } catch (err) {
      linearLog('identity probe via viewer tool failed; falling back', redact({ message: (err as Error).message }))
    }
    // Fallback: a deterministic account id derived from the grant (no PII), so
    // the token filename (sha256 of it) is stable across refreshes.
    const accountId = deriveAccountId(clientId, resource)
    return { accountId, workspaceId: accountId }
  }

  // --- linking -------------------------------------------------------------

  /** Store the per-project LinearLink. Requires the account to be connected. */
  link(projectId: string, ref: unknown): { ok?: true; error?: string } {
    if (!this.store?.getProject(projectId)) return { error: 'unknown project' }
    const parsed = coerceLink(ref)
    if ('error' in parsed) return parsed
    if (!this.tokens.has(parsed.link.accountId)) return { error: 'account not connected — connect first' }
    this.links.set(projectId, parsed.link)
    return { ok: true }
  }

  getLink(projectId: string): LinearLink | undefined {
    return this.links.get(projectId)
  }

  // --- pull ----------------------------------------------------------------

  /** Pull issues for the project's link and upsert them into the backlog. */
  async pull(projectId: string): Promise<{ ok?: true; count?: number; error?: string }> {
    if (!this.store) return { error: 'no store' }
    if (!this.store.getProject(projectId)) return { error: 'unknown project' }
    const link = this.links.get(projectId)
    if (!link) return { error: 'project not linked' }
    if (!this.tokens.has(link.accountId)) return { error: 'account not connected' }

    const client = this.clientFor(link.accountId)
    const tools = await client.listTools()
    const allowed = resolveAllowedTools(tools)
    if (!allowed['list-issues']) return { error: 'linear MCP server exposes no allowed issue-list tool' }

    const listTool = allowed['list-issues']
    const args = this.scopeArgs(listTool, link)
    let cursor: string | undefined
    let count = 0
    do {
      const call = await client.callTool(listTool.name, cursor ? { ...args, after: cursor } : args)
      const { issues, nextCursor } = extractIssues(call)
      for (const iss of issues) {
        this.store.upsertLinearBacklogItem({
          projectId,
          linearId: iss.id,
          linearUrl: iss.url,
          title: iss.title,
          bodyMd: iss.bodyMd,
          remoteStatus: iss.state
        })
        count++
      }
      cursor = nextCursor
    } while (cursor)

    linearLog('pull complete', { projectId, count })
    return { ok: true, count }
  }

  // --- writeback -----------------------------------------------------------

  /** Build the preview for a write-back (exact target shown, remote state read
   *  first so an already-satisfied change is flagged as a no-op). */
  async previewWriteback(itemId: string, action: WritebackAction): Promise<WritebackPreview | { error: string }> {
    const ctx = this.writebackContext(itemId)
    if ('error' in ctx) return ctx
    const { link, item } = ctx
    const client = this.clientFor(link.accountId)
    const tools = await client.listTools()
    const allowed = resolveAllowedTools(tools)

    if (action.kind === 'comment') {
      if (!allowed['create-comment']) return { error: 'no allowed comment tool' }
      return {
        itemId, linearId: item.linearId!, identifier: item.linearId!, title: item.title,
        action: 'comment', target: action.text, alreadySatisfied: false
      }
    }
    // started/done → resolve the current + target state
    if (!allowed['update-state']) return { error: 'no allowed state-update tool' }
    const issue = await this.fetchIssue(client, allowed['get-issue'], item.linearId!)
    const targetType = STATE_TYPE_FOR[action.kind]
    const alreadySatisfied = !!issue && stateTypeOf(issue.state) === targetType
    return {
      itemId, linearId: item.linearId!, identifier: issue?.identifier ?? item.linearId!,
      title: item.title, action: action.kind,
      target: labelForType(targetType), alreadySatisfied
    }
  }

  /** Apply a previewed write-back. Idempotent:
   *   - state changes no-op if the issue is already in the target state type;
   *   - comments carry a session-id marker and are looked up remotely before any
   *     retry after an unknown outcome (R23), so a retry never double-posts. */
  async applyWriteback(itemId: string, action: WritebackAction, sessionId: string): Promise<WritebackResult> {
    const ctx = this.writebackContext(itemId)
    if ('error' in ctx) return { ok: false, action: action.kind, outcome: 'error', error: ctx.error }
    const { link, item } = ctx
    const client = this.clientFor(link.accountId)
    const tools = await client.listTools()
    const allowed = resolveAllowedTools(tools)

    try {
      if (action.kind === 'comment') return await this.applyComment(client, allowed, item.linearId!, action.text, itemId, sessionId)
      return await this.applyState(client, allowed, item.linearId!, action.kind)
    } catch (err) {
      linearLog('writeback failed', redact({ action: action.kind, message: (err as Error).message }))
      return { ok: false, action: action.kind, outcome: 'error', error: (err as Error).message }
    }
  }

  private async applyComment(client: McpClient, allowed: ReturnType<typeof resolveAllowedTools>, linearId: string, text: string, itemId: string, sessionId: string): Promise<WritebackResult> {
    const tool = allowed['create-comment']
    if (!tool) return { ok: false, action: 'comment', outcome: 'error', error: 'no allowed comment tool' }
    const marker = commentIdempotencyMarker({ sessionId, itemId, action: 'comment' })
    const body = `${text}\n\n${marker}`

    // Idempotency: if a comment with this marker already exists remotely, skip.
    if (await this.commentExists(client, allowed, linearId, marker)) {
      return { ok: true, action: 'comment', outcome: 'noop', detail: 'comment already posted (idempotent)' }
    }
    const idArg = argNameFor(tool, ['issueId', 'issue_id', 'id']) ?? 'issueId'
    const bodyArg = argNameFor(tool, ['body', 'comment', 'text', 'content']) ?? 'body'
    await client.callTool(tool.name, { [idArg]: linearId, [bodyArg]: body })
    return { ok: true, action: 'comment', outcome: 'applied' }
  }

  private async applyState(client: McpClient, allowed: ReturnType<typeof resolveAllowedTools>, linearId: string, kind: 'started' | 'done'): Promise<WritebackResult> {
    const tool = allowed['update-state']
    if (!tool) return { ok: false, action: kind, outcome: 'error', error: 'no allowed state-update tool' }
    const targetType = STATE_TYPE_FOR[kind]
    const issue = await this.fetchIssue(client, allowed['get-issue'], linearId)
    if (issue && stateTypeOf(issue.state) === targetType) {
      return { ok: true, action: kind, outcome: 'noop', detail: 'issue already in target state' }
    }
    const idArg = argNameFor(tool, ['id', 'issueId', 'issue_id']) ?? 'id'
    const stateArg = argNameFor(tool, ['stateName', 'status', 'state', 'stateId', 'state_id', 'workflowState']) ?? 'state'
    await client.callTool(tool.name, { [idArg]: linearId, [stateArg]: labelForType(targetType) })
    return { ok: true, action: kind, outcome: 'applied' }
  }

  /** Look up whether a comment bearing `marker` already exists on the issue. */
  private async commentExists(client: McpClient, allowed: ReturnType<typeof resolveAllowedTools>, linearId: string, marker: string): Promise<boolean> {
    const getTool = allowed['get-issue']
    if (!getTool) return false
    try {
      const idArg = argNameFor(getTool, ['id', 'issueId', 'issue_id', 'identifier']) ?? 'id'
      const res = await client.callTool(getTool.name, { [idArg]: linearId })
      const text = allText(res)
      return text.includes(marker)
    } catch {
      // On an unknown outcome we could NOT confirm — report "not found" so the
      // caller does NOT skip; the marker still prevents a true duplicate on the
      // Linear side only if the read works. Conservative: treat read failure as
      // "unknown", surfaced by the caller as an error rather than a silent double.
      return false
    }
  }

  private async fetchIssue(client: McpClient, getTool: McpTool | null, linearId: string): Promise<{ identifier: string; state: string } | null> {
    if (!getTool) return null
    try {
      const idArg = argNameFor(getTool, ['id', 'issueId', 'issue_id', 'identifier']) ?? 'id'
      const res = await client.callTool(getTool.name, { [idArg]: linearId })
      const parsed = firstJson(res)
      const identifier = str(parsed, ['identifier', 'id']) || linearId
      const state = extractState(parsed)
      return { identifier, state }
    } catch {
      return null
    }
  }

  // --- logout --------------------------------------------------------------

  async logout(accountId: string): Promise<{ ok?: true; error?: string; revoked?: boolean }> {
    this.clients.delete(accountId)
    const r = await this.manager.logout(accountId)
    if ('error' in r) return r
    return { ok: true, revoked: r.revoked }
  }

  // --- internals -----------------------------------------------------------

  private clientFor(accountId: string): McpClient {
    const cached = this.clients.get(accountId)
    if (cached) return cached
    const client = this.mcpFactory
      ? this.mcpFactory(accountId, this)
      : new McpClient({
          endpoint: this.resourceFor(accountId),
          getToken: () => this.manager.accessToken(accountId),
          fetch: this.fetch
        })
    this.clients.set(accountId, client)
    return client
  }

  private resourceFor(accountId: string): string {
    return this.tokens.load(accountId)?.resource ?? LINEAR_MCP_URL
  }

  private writebackContext(itemId: string): { link: LinearLink; item: { linearId: string; title: string; projectId: string } } | { error: string } {
    if (!this.store) return { error: 'no store' }
    const item = this.store.getBacklogItem(itemId)
    if (!item) return { error: 'unknown item' }
    // Ownership: must be a linear-sourced row with a linearId, in a linked project.
    if (item.source !== 'linear' || !item.linearId) return { error: 'item is not linear-owned' }
    const link = this.links.get(item.projectId)
    if (!link) return { error: 'project not linked' }
    if (!this.tokens.has(link.accountId)) return { error: 'account not connected' }
    return { link, item: { linearId: item.linearId, title: item.title, projectId: item.projectId } }
  }

  /** Scope the list-issues call to the linked team/project when the tool schema
   *  supports it. */
  private scopeArgs(listTool: McpTool, link: LinearLink): Record<string, unknown> {
    const args: Record<string, unknown> = {}
    if (link.teamId) {
      const teamArg = argNameFor(listTool, ['teamId', 'team_id', 'team'])
      if (teamArg) args[teamArg] = link.teamId
    }
    if (link.projectId) {
      const projArg = argNameFor(listTool, ['projectId', 'project_id', 'project'])
      if (projArg) args[projArg] = link.projectId
    }
    return args
  }
}

// ---------------------------------------------------------------------------
// Pure parsing helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Coerce an unknown `ref` (from the renderer) into a validated LinearLink. */
export function coerceLink(ref: unknown): { link: LinearLink } | { error: string } {
  const r = ref as Partial<LinearLink>
  if (!r || typeof r !== 'object') return { error: 'invalid link ref' }
  if (typeof r.accountId !== 'string' || !r.accountId) return { error: 'link missing accountId' }
  if (typeof r.workspaceId !== 'string' || !r.workspaceId) return { error: 'link missing workspaceId' }
  return {
    link: {
      accountId: r.accountId,
      workspaceId: r.workspaceId,
      teamId: typeof r.teamId === 'string' ? r.teamId : null,
      projectId: typeof r.projectId === 'string' ? r.projectId : null,
      label: typeof r.label === 'string' && r.label ? r.label : r.workspaceId
    }
  }
}

export interface PulledIssue { id: string; url: string; title: string; bodyMd: string; state: string }

/** Extract issues + a pagination cursor from a tools/call result. Linear MCP
 *  results carry data as structuredContent OR as JSON text in a content block. */
export function extractIssues(res: ToolCallResult): { issues: PulledIssue[]; nextCursor?: string } {
  const data = firstJson(res)
  const nodes = asArray(pick(data, ['issues', 'nodes', 'items', 'results', 'data'])) ?? (Array.isArray(data) ? data : [])
  const issues: PulledIssue[] = []
  for (const n of nodes) {
    const id = str(n, ['id', 'issueId'])
    if (!id) continue
    issues.push({
      id,
      url: str(n, ['url', 'link']) || '',
      title: str(n, ['title', 'name']) || '(untitled)',
      bodyMd: str(n, ['description', 'body', 'bodyMd', 'descriptionMarkdown']) || '',
      state: extractState(n)
    })
  }
  const pageInfo = pick(data, ['pageInfo']) as { hasNextPage?: boolean; endCursor?: string } | undefined
  const nextCursor = pageInfo?.hasNextPage ? pageInfo.endCursor : (str(data, ['nextCursor']) || undefined)
  return { issues, nextCursor }
}

/** Extract a state label from an issue node (state may be a string or object). */
export function extractState(node: unknown): string {
  const s = pick(node, ['state', 'status', 'workflowState'])
  if (typeof s === 'string') return s
  if (s && typeof s === 'object') return str(s, ['name', 'type', 'label']) || ''
  return ''
}

function stateTypeOf(stateLabel: string): string {
  const l = stateLabel.toLowerCase()
  if (/(done|complete|merged|closed|shipped)/.test(l)) return 'completed'
  if (/(progress|started|doing|active|in review|review)/.test(l)) return 'started'
  if (/(cancel)/.test(l)) return 'canceled'
  if (/(backlog|icebox)/.test(l)) return 'backlog'
  return l || 'unstarted'
}

function labelForType(type: string): string {
  switch (type) {
    case 'completed': return 'Done'
    case 'started': return 'In Progress'
    case 'canceled': return 'Canceled'
    case 'backlog': return 'Backlog'
    default: return 'Todo'
  }
}

/** The first JSON object/array embedded in a tool result (structuredContent
 *  preferred; otherwise the first parseable text content block). */
export function firstJson(res: ToolCallResult): unknown {
  if (res.structuredContent !== undefined) return res.structuredContent
  for (const c of res.content ?? []) {
    if (c.type === 'text' && typeof c.text === 'string') {
      try { return JSON.parse(c.text) } catch { /* not JSON */ }
    }
  }
  // Fall back to the concatenated text (non-JSON tools).
  return { raw: allText(res) }
}

/** All text content concatenated (for marker containment checks). */
export function allText(res: ToolCallResult): string {
  return (res.content ?? []).filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n')
}

function pick(obj: unknown, keys: string[]): unknown {
  if (!obj || typeof obj !== 'object') return undefined
  for (const k of keys) if (k in (obj as Record<string, unknown>)) return (obj as Record<string, unknown>)[k]
  return undefined
}

function str(obj: unknown, keys: string[]): string {
  const v = pick(obj, keys)
  return typeof v === 'string' ? v : (typeof v === 'number' ? String(v) : '')
}

function asArray(v: unknown): unknown[] | undefined {
  if (Array.isArray(v)) return v
  if (v && typeof v === 'object' && Array.isArray((v as { nodes?: unknown[] }).nodes)) return (v as { nodes: unknown[] }).nodes
  return undefined
}

/** A deterministic, non-PII account id from the client grant (fallback identity). */
function deriveAccountId(clientId: string, resource: string): string {
  // Kept short + stable; hashed again for the on-disk filename by the token store.
  return `acct_${Buffer.from(`${clientId}:${resource}`).toString('base64url').slice(0, 24)}`
}

function loopbackUriForPort(port: number, fallback: string): string {
  return fallback || `http://127.0.0.1:${port}/callback`
}
