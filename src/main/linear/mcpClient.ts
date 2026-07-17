// Minimal MCP (Model Context Protocol) client over Streamable HTTP for the
// Linear hosted MCP endpoint (S2, C-16). Implements:
//   - initialize / protocol-version negotiation + notifications/initialized
//   - Mcp-Session-Id header capture + echo on subsequent requests
//   - POST requests that accept EITHER a single application/json response OR an
//     SSE (text/event-stream) stream whose data frames carry the JSON-RPC reply
//   - tools/list with an ALLOWLIST (name-pattern + schema shape validation)
//   - tools/call with cursor pagination
//   - per-request timeout + AbortController cancellation
//   - reinitialize-on-session-expiry (a 404 / -32001-style expiry re-runs the
//     handshake once, transparently)
//
// The Bearer token is supplied per request by an async provider so refreshes
// (with rotation) are picked up transparently. ALL logs route through redact().

import { linearLog, redact, type FetchLike } from './oauth'

/** The MCP protocol version this client speaks. */
export const MCP_PROTOCOL_VERSION = '2025-06-18'

const DEFAULT_TIMEOUT_MS = 30_000

export interface JsonRpcError { code: number; message: string; data?: unknown }

export interface McpTool {
  name: string
  description?: string
  inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] }
}

export interface ToolCallResult {
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>
  structuredContent?: unknown
  isError?: boolean
}

export interface McpClientOptions {
  endpoint: string
  /** Async Bearer-token provider (called before every request → picks up refresh). */
  getToken: () => Promise<string>
  fetch?: FetchLike
  timeoutMs?: number
  /** Called when the session id changes (re)established — for observability. */
  onSession?: (sessionId: string | null) => void
}

/** Raised when the server signals the MCP session has expired/is unknown. */
export class SessionExpiredError extends Error {
  constructor() { super('mcp session expired'); this.name = 'SessionExpiredError' }
}

export class McpClient {
  private endpoint: string
  private getToken: () => Promise<string>
  private fetch: FetchLike
  private timeoutMs: number
  private onSession?: (s: string | null) => void

  private sessionId: string | null = null
  private negotiatedVersion: string | null = null
  private initialized = false
  private nextId = 1

  constructor(opts: McpClientOptions) {
    this.endpoint = opts.endpoint
    this.getToken = opts.getToken
    this.fetch = opts.fetch ?? fetch
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.onSession = opts.onSession
  }

  get currentSessionId(): string | null { return this.sessionId }
  get protocolVersion(): string | null { return this.negotiatedVersion }

  /** Run the initialize handshake (idempotent — a no-op if already initialized). */
  async initialize(): Promise<void> {
    if (this.initialized) return
    await this.doInitialize()
  }

  private async doInitialize(): Promise<void> {
    this.sessionId = null
    this.initialized = false
    const result = await this.rpc('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'agent-ide', version: '2.0.0' }
    }, { allowReinit: false })
    const negotiated = (result as { protocolVersion?: string })?.protocolVersion
    this.negotiatedVersion = typeof negotiated === 'string' ? negotiated : MCP_PROTOCOL_VERSION
    // Per spec the client sends notifications/initialized after a successful init.
    await this.notify('notifications/initialized', {})
    this.initialized = true
    linearLog('mcp initialized', { protocolVersion: this.negotiatedVersion, hasSession: this.sessionId != null })
  }

  /** tools/list, filtered through the allowlist. Follows nextCursor pagination. */
  async listTools(): Promise<McpTool[]> {
    await this.initialize()
    const all: McpTool[] = []
    let cursor: string | undefined
    do {
      const res = (await this.rpc('tools/list', cursor ? { cursor } : {})) as { tools?: McpTool[]; nextCursor?: string }
      for (const t of res.tools ?? []) all.push(t)
      cursor = res.nextCursor
    } while (cursor)
    return all
  }

  /** tools/call for a single tool. Returns the raw result (allowlist enforcement
   *  is the caller's — linearService — responsibility). */
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    await this.initialize()
    return (await this.rpc('tools/call', { name, arguments: args })) as ToolCallResult
  }

  // --- transport -----------------------------------------------------------

  /** Issue a JSON-RPC request; transparently reinitialize + retry ONCE on a
   *  session-expiry signal. Returns the `result` field. */
  private async rpc(method: string, params: unknown, opts: { allowReinit?: boolean } = {}): Promise<unknown> {
    const allowReinit = opts.allowReinit ?? true
    try {
      return await this.rawRequest(method, params)
    } catch (err) {
      if (err instanceof SessionExpiredError && allowReinit && method !== 'initialize') {
        linearLog('mcp session expired — reinitializing')
        await this.doInitialize()
        return this.rawRequest(method, params)
      }
      throw err
    }
  }

  /** Fire-and-forget notification (no id, no response body expected). */
  private async notify(method: string, params: unknown): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await this.fetch(this.endpoint, {
        method: 'POST',
        headers: await this.headers(),
        body: JSON.stringify({ jsonrpc: '2.0', method, params }),
        signal: controller.signal
      })
      this.captureSession(res)
      // 202 Accepted (no body) is the expected notification response; drain any body.
      if (res.body && typeof (res as { text?: unknown }).text === 'function') { try { await res.text() } catch { /* ignore */ } }
    } finally {
      clearTimeout(timer)
    }
  }

  private async rawRequest(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let res: Awaited<ReturnType<FetchLike>>
    try {
      res = await this.fetch(this.endpoint, {
        method: 'POST',
        headers: await this.headers(),
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: controller.signal
      })
    } catch (err) {
      clearTimeout(timer)
      if ((err as Error)?.name === 'AbortError') throw new Error(`mcp request timed out: ${method}`)
      throw err
    }
    try {
      this.captureSession(res)

      // A 404 on an established session means the session was dropped by the server.
      if (res.status === 404 && this.sessionId) throw new SessionExpiredError()
      if (res.status === 401) throw new Error('mcp unauthorized (token rejected)')
      if (!res.ok && res.status !== 200) {
        // Read the JSON-RPC error without echoing an arbitrary error body verbatim.
        const parsed = await this.readMessage(res).catch(() => null)
        if (parsed && parsed.error) throw this.rpcError(parsed.error)
        throw new Error(`mcp http ${res.status} on ${method}`)
      }

      const msg = await this.readMessage(res)
      if (!msg) throw new Error(`mcp: empty response for ${method}`)
      if (msg.error) {
        if (isSessionExpiryError(msg.error)) throw new SessionExpiredError()
        throw this.rpcError(msg.error)
      }
      return msg.result
    } finally {
      clearTimeout(timer)
    }
  }

  /** Read a JSON-RPC message from either a plain JSON body or an SSE stream. */
  private async readMessage(res: Awaited<ReturnType<FetchLike>>): Promise<{ result?: unknown; error?: JsonRpcError } | null> {
    const ct = res.headers.get('content-type') ?? ''
    const text = await res.text()
    if (!text) return null
    if (ct.includes('text/event-stream')) {
      return parseSseForResponse(text)
    }
    try {
      return JSON.parse(text) as { result?: unknown; error?: JsonRpcError }
    } catch {
      // Some servers send SSE without the exact content-type; try SSE as a fallback.
      const sse = parseSseForResponse(text)
      if (sse) return sse
      throw new Error('mcp: unparseable response body')
    }
  }

  private captureSession(res: Awaited<ReturnType<FetchLike>>): void {
    const sid = res.headers.get('mcp-session-id')
    if (sid && sid !== this.sessionId) {
      this.sessionId = sid
      this.onSession?.(sid)
    }
  }

  private async headers(): Promise<Record<string, string>> {
    const token = await this.getToken()
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      // Advertise support for BOTH single-JSON and SSE responses.
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
      'MCP-Protocol-Version': this.negotiatedVersion ?? MCP_PROTOCOL_VERSION
    }
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId
    return h
  }

  private rpcError(e: JsonRpcError): Error {
    linearLog('mcp rpc error', redact({ code: e.code, message: e.message }))
    return new Error(`mcp error ${e.code}: ${e.message}`)
  }
}

/** A JSON-RPC error signalling the session must be re-established. Linear/MCP
 *  servers commonly use -32001 ("session not found") or a 404 (handled above). */
function isSessionExpiryError(e: JsonRpcError): boolean {
  return e.code === -32001 || /session (not found|expired|invalid)/i.test(e.message ?? '')
}

/** Extract the LAST JSON-RPC message with a `result` or `error` field from an
 *  SSE payload (data: lines). Exported for unit tests. */
export function parseSseForResponse(sse: string): { result?: unknown; error?: JsonRpcError } | null {
  let found: { result?: unknown; error?: JsonRpcError } | null = null
  for (const rawLine of sse.split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') continue
    try {
      const obj = JSON.parse(data) as { result?: unknown; error?: JsonRpcError; id?: unknown }
      if ('result' in obj || 'error' in obj) found = obj
    } catch { /* skip non-JSON data frames (comments, keep-alives) */ }
  }
  return found
}
