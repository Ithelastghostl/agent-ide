// A LOCAL fake Linear MCP + OAuth server (node http) for S2 protocol-path tests.
// Implements the FULL handshake with NO live network:
//   OAuth: /.well-known/oauth-protected-resource, /.well-known/oauth-authorization-server,
//          POST /register (DCR), POST /token (authorization_code + refresh_token), POST /revoke
//   MCP  : POST /mcp — initialize (version negotiation) + notifications/initialized,
//          Mcp-Session-Id issuance/echo/expiry, tools/list, paginated tools/call
//          (list_issues), get_issue, update_issue, create_comment; session-expiry reinit.
//
// The server is deliberately configurable (forceSessionExpiryOnce, sseResponses)
// so tests can drive the non-happy paths.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'

export interface FakeServerOptions {
  /** Emit tool/list + tool/call replies as SSE (text/event-stream) instead of JSON. */
  sse?: boolean
  /** After a session is established, reject the NEXT MCP request once with a
   *  session-expiry error, forcing the client to reinitialize. */
  forceSessionExpiryOnce?: boolean
  /** Page size for list_issues pagination. */
  pageSize?: number
  /** Total issues the fake workspace holds. */
  totalIssues?: number
}

export interface FakeServer {
  server: Server
  url: string // base origin, e.g. http://127.0.0.1:PORT
  mcpUrl: string
  /** Recorded state for assertions. */
  state: {
    registrations: number
    tokenGrants: number
    refreshes: number
    revocations: number
    initializations: number
    toolCalls: Array<{ name: string; args: Record<string, unknown> }>
    comments: Array<{ issueId: string; body: string }>
    /** issueId → state label (mutated by update_issue). */
    issueStates: Map<string, string>
  }
  close: () => Promise<void>
}

const ISSUE_STATE_DEFAULT = 'Todo'

export async function startFakeLinearServer(opts: FakeServerOptions = {}): Promise<FakeServer> {
  const pageSize = opts.pageSize ?? 2
  const totalIssues = opts.totalIssues ?? 5
  const state: FakeServer['state'] = {
    registrations: 0,
    tokenGrants: 0,
    refreshes: 0,
    revocations: 0,
    initializations: 0,
    toolCalls: [],
    comments: [],
    issueStates: new Map()
  }
  for (let i = 1; i <= totalIssues; i++) state.issueStates.set(`iss-${i}`, ISSUE_STATE_DEFAULT)

  let currentSession: string | null = null
  let expiryArmed = !!opts.forceSessionExpiryOnce
  let base = ''

  const server = createServer((req, res) => {
    void handle(req, res)
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', base)
    const path = url.pathname

    // --- OAuth discovery ---
    if (
      path === '/.well-known/oauth-protected-resource' ||
      path.startsWith('/.well-known/oauth-protected-resource')
    ) {
      return sendJson(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] })
    }
    if (
      path === '/.well-known/oauth-authorization-server' ||
      path.startsWith('/.well-known/oauth-authorization-server')
    ) {
      return sendJson(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        revocation_endpoint: `${base}/revoke`,
        code_challenge_methods_supported: ['S256'],
        scopes_supported: ['read', 'write']
      })
    }
    if (path === '/register' && req.method === 'POST') {
      await readBody(req)
      state.registrations++
      return sendJson(res, 201, { client_id: `client-${randomUUID()}`, token_endpoint_auth_method: 'none' })
    }
    if (path === '/token' && req.method === 'POST') {
      const body = await readBody(req)
      if (body.includes('grant_type=refresh_token')) {
        state.refreshes++
        return sendJson(res, 200, {
          access_token: `at-${state.refreshes}`,
          refresh_token: `rt-${state.refreshes}`,
          expires_in: 3600,
          token_type: 'Bearer'
        })
      }
      state.tokenGrants++
      return sendJson(res, 200, {
        access_token: 'at-initial',
        refresh_token: 'rt-initial',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'read write'
      })
    }
    if (path === '/revoke' && req.method === 'POST') {
      await readBody(req)
      state.revocations++
      return sendJson(res, 200, {})
    }

    // --- MCP endpoint ---
    if (path === '/mcp' && req.method === 'POST') {
      // Auth challenge: without a Bearer token, respond 401 (protected resource).
      if (!/^Bearer .+/i.test(req.headers['authorization'] ?? '')) {
        return sendJson(res, 401, { error: 'unauthorized' })
      }
      const rpc = JSON.parse((await readBody(req)) || '{}') as { id?: number; method?: string; params?: any }
      return handleMcp(req, res, rpc)
    }

    sendJson(res, 404, { error: 'not found' })
  }

  function handleMcp(
    req: IncomingMessage,
    res: ServerResponse,
    rpc: { id?: number; method?: string; params?: any }
  ): void {
    const method = rpc.method ?? ''
    const sessionHeader = (req.headers['mcp-session-id'] as string | undefined) ?? null

    // notifications/initialized: 202, no body.
    if (method === 'notifications/initialized') {
      res.writeHead(202).end()
      return
    }

    if (method === 'initialize') {
      state.initializations++
      currentSession = `sess-${randomUUID()}`
      // NOTE: expiryArmed is a ONE-SHOT for the whole server lifetime — it is
      // NOT re-armed here, so after the single forced expiry + reinit the client
      // proceeds normally (exactly one reinitialization).
      res.setHeader('Mcp-Session-Id', currentSession)
      return replyResult(res, rpc.id, {
        protocolVersion: rpc.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-linear', version: '1.0.0' }
      })
    }

    // All other methods require a matching session.
    if (!currentSession || sessionHeader !== currentSession) {
      // Unknown/expired session → 404 (client reinitializes).
      return sendJson(res, 404, {
        jsonrpc: '2.0',
        id: rpc.id,
        error: { code: -32001, message: 'session not found' }
      })
    }

    // One-shot forced expiry AFTER a session exists, to exercise reinit.
    if (expiryArmed) {
      expiryArmed = false
      currentSession = null
      return sendJson(res, 404, {
        jsonrpc: '2.0',
        id: rpc.id,
        error: { code: -32001, message: 'session expired' }
      })
    }

    if (method === 'tools/list') {
      return replyResult(res, rpc.id, { tools: TOOLS })
    }

    if (method === 'tools/call') {
      const name = rpc.params?.name as string
      const args = (rpc.params?.arguments ?? {}) as Record<string, unknown>
      state.toolCalls.push({ name, args })
      return replyResult(res, rpc.id, runTool(name, args))
    }

    return sendJson(res, 400, {
      jsonrpc: '2.0',
      id: rpc.id,
      error: { code: -32601, message: `method not found: ${method}` }
    })
  }

  function runTool(name: string, args: Record<string, unknown>): unknown {
    if (name === 'viewer') {
      return toolContent({ id: 'user-abc', organizationId: 'org-xyz', name: 'Test User' })
    }
    if (name === 'list_issues') {
      const after = typeof args.after === 'string' ? Number(args.after) : 0
      const slice: any[] = []
      for (let i = after + 1; i <= Math.min(after + pageSize, totalIssues); i++) {
        const id = `iss-${i}`
        slice.push({
          id,
          identifier: `ENG-${i}`,
          title: `Issue ${i}`,
          url: `https://linear.app/x/issue/ENG-${i}`,
          description: `Body ${i}`,
          state: { name: state.issueStates.get(id) ?? ISSUE_STATE_DEFAULT, type: 'unstarted' }
        })
      }
      const end = after + pageSize
      const hasNext = end < totalIssues
      return toolContent({
        issues: slice,
        pageInfo: { hasNextPage: hasNext, endCursor: hasNext ? String(end) : null }
      })
    }
    if (name === 'get_issue') {
      const id = (args.id ?? args.issueId ?? args.identifier) as string
      const label = state.issueStates.get(id) ?? ISSUE_STATE_DEFAULT
      const comments = state.comments
        .filter((c) => c.issueId === id)
        .map((c) => c.body)
        .join('\n')
      return toolContent({
        id,
        identifier: id,
        title: `Issue for ${id}`,
        state: { name: label, type: labelType(label) },
        comments
      })
    }
    if (name === 'update_issue') {
      const id = (args.id ?? args.issueId) as string
      const target = (args.stateName ?? args.status ?? args.state ?? args.stateId) as string
      state.issueStates.set(id, target)
      return toolContent({ id, success: true, state: { name: target } })
    }
    if (name === 'create_comment') {
      const issueId = (args.issueId ?? args.id) as string
      const body = (args.body ?? args.comment ?? args.text) as string
      state.comments.push({ issueId, body })
      return toolContent({ id: `cmt-${randomUUID()}`, success: true })
    }
    return toolContent({ error: `unknown tool ${name}` })
  }

  function toolContent(obj: unknown): unknown {
    return { content: [{ type: 'text', text: JSON.stringify(obj) }], structuredContent: obj }
  }

  function replyResult(res: ServerResponse, id: number | undefined, result: unknown): void {
    const msg = { jsonrpc: '2.0', id, result }
    if (opts.sse) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(`event: message\ndata: ${JSON.stringify(msg)}\n\n`)
    } else {
      sendJson(res, 200, msg)
    }
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  const port = addr && typeof addr === 'object' ? addr.port : 0
  base = `http://127.0.0.1:${port}`

  return {
    server,
    url: base,
    mcpUrl: `${base}/mcp`,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

function labelType(label: string): string {
  const l = label.toLowerCase()
  if (/done|complete/.test(l)) return 'completed'
  if (/progress|started/.test(l)) return 'started'
  return 'unstarted'
}

const TOOLS = [
  {
    name: 'list_issues',
    description: 'List issues',
    inputSchema: { type: 'object', properties: { teamId: {}, projectId: {}, first: {}, after: {} } }
  },
  { name: 'get_issue', description: 'Get an issue', inputSchema: { type: 'object', properties: { id: {} } } },
  {
    name: 'update_issue',
    description: 'Update an issue',
    inputSchema: { type: 'object', properties: { id: {}, stateName: {}, title: {} } }
  },
  {
    name: 'create_comment',
    description: 'Comment on an issue',
    inputSchema: { type: 'object', properties: { issueId: {}, body: {} } }
  },
  { name: 'viewer', description: 'Current user', inputSchema: { type: 'object', properties: {} } }
]

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(payload)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => {
      data += c
    })
    req.on('end', () => resolve(data))
    req.on('error', () => resolve(data))
  })
}
