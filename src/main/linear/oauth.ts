// Linear hosted-MCP OAuth 2.1 client (S2). Implements the discovery →
// dynamic-client-registration → PKCE authorization_code (loopback) → token
// flow described in the v2 plan (C-15/16/17, R15-23). The functions here are
// split into PURE helpers (unit-tested directly) and an I/O flow that drives a
// loopback listener + the system browser via the caller's openExternal.
//
// SECURITY: every log line in this module routes through redact() — no header,
// token, URL, code, verifier, or error body is ever emitted verbatim.

import { createHash, randomBytes, createHmac } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { URL, URLSearchParams } from 'node:url'

/** The Linear hosted MCP endpoint (the OAuth protected resource). */
export const LINEAR_MCP_URL = 'https://mcp.linear.app/mcp'

// ---------------------------------------------------------------------------
// Redaction (used by every logger in the Linear modules)
// ---------------------------------------------------------------------------
const SECRET_KEYS = /(authorization|cookie|token|secret|code|verifier|assertion|password|bearer)/i

/** Redact secrets from an arbitrary value for logging. Strings that look like
 *  URLs are reduced to their origin+path (query/fragment dropped — they can
 *  carry codes/tokens); object keys matching SECRET_KEYS are masked; long
 *  opaque strings are truncated. NEVER logs a raw token/header/URL/error body. */
export function redact(value: unknown, depth = 0): unknown {
  if (value == null) return value
  if (typeof value === 'string') return redactString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (depth > 4) return '[deep]'
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1)
    }
    return out
  }
  return '[unloggable]'
}

function redactString(s: string): string {
  // Strip query/fragment from anything URL-shaped (they can hold code/token).
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s)
      return `${u.origin}${u.pathname}`
    } catch {
      return '[url]'
    }
  }
  // Mask long opaque blobs (likely tokens/hashes).
  if (s.length > 64 && /^[A-Za-z0-9._~+/=-]+$/.test(s)) return `[opaque:${s.length}]`
  return s
}

/** A redaction-safe console logger for the Linear subsystem. */
export function linearLog(msg: string, detail?: unknown): void {
  if (detail === undefined) console.log(`[linear] ${msg}`)
  else console.log(`[linear] ${msg}`, redact(detail))
}

// ---------------------------------------------------------------------------
// PKCE (RFC 7636) — pure
// ---------------------------------------------------------------------------
function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** A high-entropy code verifier (RFC 7636 §4.1: 43–128 chars, unreserved set). */
export function generateCodeVerifier(): string {
  return base64url(randomBytes(64)) // 64 bytes → 86 base64url chars
}

/** S256 code challenge for a verifier. */
export function codeChallengeS256(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest())
}

/** An opaque anti-CSRF state value bound to the authorization request. */
export function generateState(): string {
  return base64url(randomBytes(32))
}

/** Constant-time string comparison (state validation must not leak via timing). */
export function safeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return ha.length === hb.length && timingSafe(ha, hb)
}

function timingSafe(a: Buffer, b: Buffer): boolean {
  let diff = a.length ^ b.length
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ (b[i] ?? 0)
  return diff === 0
}

// ---------------------------------------------------------------------------
// OAuth metadata shapes
// ---------------------------------------------------------------------------
export interface ProtectedResourceMetadata {
  resource?: string
  authorization_servers?: string[]
}

export interface AuthServerMetadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  revocation_endpoint?: string
  code_challenge_methods_supported?: string[]
  scopes_supported?: string[]
}

export interface RegisteredClient {
  client_id: string
  client_secret?: string
  client_id_issued_at?: number
  token_endpoint_auth_method?: string
}

export interface TokenResponse {
  access_token: string
  token_type: string
  expires_in?: number
  refresh_token?: string
  scope?: string
}

/** Validate the authorization-server metadata document has the required
 *  endpoints and (if it declares PKCE methods) advertises S256. Pure. */
export function validateAuthServerMetadata(raw: unknown): AuthServerMetadata {
  const m = raw as Partial<AuthServerMetadata>
  if (!m || typeof m !== 'object') throw new Error('auth-server metadata not an object')
  if (typeof m.issuer !== 'string') throw new Error('auth-server metadata missing issuer')
  if (typeof m.authorization_endpoint !== 'string') throw new Error('missing authorization_endpoint')
  if (typeof m.token_endpoint !== 'string') throw new Error('missing token_endpoint')
  for (const ep of [m.authorization_endpoint, m.token_endpoint]) {
    if (!isSecureOrLoopback(ep!)) throw new Error('non-https endpoint rejected')
  }
  const methods = m.code_challenge_methods_supported
  if (Array.isArray(methods) && methods.length > 0 && !methods.includes('S256')) {
    throw new Error('auth server does not support S256 PKCE')
  }
  return m as AuthServerMetadata
}

/** True for an https URL, OR an http loopback URL (127.0.0.1/localhost/[::1]) —
 *  the latter permits a local fake/dev auth server without weakening the https
 *  requirement for any real remote endpoint. */
export function isSecureOrLoopback(url: string): boolean {
  if (/^https:\/\//i.test(url)) return true
  try {
    const u = new URL(url)
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1' || u.hostname === '[::1]')
  } catch {
    return false
  }
}

/** Build the exact loopback redirect URI for a chosen port (must match the
 *  value registered + sent to /authorize byte-for-byte). Pure. */
export function loopbackRedirectUri(port: number): string {
  return `http://127.0.0.1:${port}/callback`
}

/** Compose the /authorize URL from metadata + PKCE + state. Pure. */
export function buildAuthorizeUrl(a: {
  meta: AuthServerMetadata
  clientId: string
  redirectUri: string
  state: string
  codeChallenge: string
  scope?: string
  resource?: string
}): string {
  const u = new URL(a.meta.authorization_endpoint)
  const params: Record<string, string> = {
    response_type: 'code',
    client_id: a.clientId,
    redirect_uri: a.redirectUri,
    state: a.state,
    code_challenge: a.codeChallenge,
    code_challenge_method: 'S256'
  }
  if (a.scope) params.scope = a.scope
  // RFC 8707 resource indicator — bind the token to the MCP resource.
  if (a.resource) params.resource = a.resource
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  return u.toString()
}

/** Parse the loopback callback query into {code, state} or an OAuth error. Pure. */
export function parseCallbackQuery(rawUrl: string): { code?: string; state?: string; error?: string } {
  const q = new URL(rawUrl, 'http://127.0.0.1').searchParams
  const error = q.get('error')
  if (error) return { error: `${error}${q.get('error_description') ? `: ${q.get('error_description')}` : ''}` }
  return { code: q.get('code') ?? undefined, state: q.get('state') ?? undefined }
}

// ---------------------------------------------------------------------------
// HTTP helpers (discovery / registration / token). Isolated for test injection.
// ---------------------------------------------------------------------------
export type FetchLike = typeof fetch

/** Discover the protected-resource metadata for the MCP endpoint (RFC 9728).
 *  Tries the well-known path derived from the resource URL. */
export async function discoverProtectedResource(resourceUrl: string, f: FetchLike = fetch): Promise<ProtectedResourceMetadata> {
  const u = new URL(resourceUrl)
  const wellKnown = `${u.origin}/.well-known/oauth-protected-resource${u.pathname === '/' ? '' : u.pathname}`
  const res = await f(wellKnown, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`protected-resource discovery failed (${res.status})`)
  return (await res.json()) as ProtectedResourceMetadata
}

/** Discover the authorization-server metadata (RFC 8414). */
export async function discoverAuthServer(issuerUrl: string, f: FetchLike = fetch): Promise<AuthServerMetadata> {
  const u = new URL(issuerUrl)
  // RFC 8414: well-known is inserted after the origin, before any path component.
  const path = u.pathname === '/' ? '' : u.pathname
  const candidates = [
    `${u.origin}/.well-known/oauth-authorization-server${path}`,
    `${u.origin}/.well-known/openid-configuration${path}`
  ]
  let lastErr: Error | undefined
  for (const c of candidates) {
    try {
      const res = await f(c, { headers: { Accept: 'application/json' } })
      if (res.ok) return validateAuthServerMetadata(await res.json())
      lastErr = new Error(`auth-server discovery ${res.status}`)
    } catch (err) {
      lastErr = err as Error
    }
  }
  throw lastErr ?? new Error('auth-server discovery failed')
}

/** Dynamic client registration (RFC 7591). */
export async function registerClient(a: {
  meta: AuthServerMetadata
  redirectUri: string
  f?: FetchLike
}): Promise<RegisteredClient> {
  const f = a.f ?? fetch
  if (!a.meta.registration_endpoint) throw new Error('auth server has no registration_endpoint (DCR unsupported)')
  const body = {
    client_name: 'Agent IDE',
    redirect_uris: [a.redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none', // public client (PKCE)
    application_type: 'native'
  }
  const res = await f(a.meta.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) throw new Error(`dynamic client registration failed (${res.status})`)
  const reg = (await res.json()) as RegisteredClient
  if (!reg.client_id) throw new Error('registration response missing client_id')
  return reg
}

/** Exchange an authorization code for tokens (PKCE, RFC 6749 + 7636). */
export async function exchangeCode(a: {
  meta: AuthServerMetadata
  clientId: string
  clientSecret?: string
  code: string
  codeVerifier: string
  redirectUri: string
  resource?: string
  f?: FetchLike
}): Promise<TokenResponse> {
  const f = a.f ?? fetch
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code: a.code,
    redirect_uri: a.redirectUri,
    client_id: a.clientId,
    code_verifier: a.codeVerifier
  })
  if (a.clientSecret) params.set('client_secret', a.clientSecret)
  if (a.resource) params.set('resource', a.resource)
  return tokenRequest(a.meta.token_endpoint, params, f)
}

/** Refresh an access token WITH rotation (a returned refresh_token replaces the
 *  old one; callers must persist the new value). */
export async function refreshToken(a: {
  meta: AuthServerMetadata
  clientId: string
  clientSecret?: string
  refreshToken: string
  resource?: string
  f?: FetchLike
}): Promise<TokenResponse> {
  const f = a.f ?? fetch
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: a.refreshToken,
    client_id: a.clientId
  })
  if (a.clientSecret) params.set('client_secret', a.clientSecret)
  if (a.resource) params.set('resource', a.resource)
  return tokenRequest(a.meta.token_endpoint, params, f)
}

/** Revoke a token at the revocation endpoint if the server advertises one
 *  (RFC 7009). Best-effort: a non-2xx or a missing endpoint is not fatal. */
export async function revokeToken(a: {
  meta: AuthServerMetadata
  clientId: string
  token: string
  tokenTypeHint?: 'access_token' | 'refresh_token'
  f?: FetchLike
}): Promise<boolean> {
  if (!a.meta.revocation_endpoint) return false
  const f = a.f ?? fetch
  const params = new URLSearchParams({ token: a.token, client_id: a.clientId })
  if (a.tokenTypeHint) params.set('token_type_hint', a.tokenTypeHint)
  try {
    const res = await f(a.meta.revocation_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: params.toString()
    })
    return res.ok
  } catch {
    return false
  }
}

async function tokenRequest(endpoint: string, params: URLSearchParams, f: FetchLike): Promise<TokenResponse> {
  const res = await f(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: params.toString()
  })
  if (!res.ok) {
    // Do NOT surface the raw error body (may echo the code/token). Status only.
    throw new Error(`token endpoint error (${res.status})`)
  }
  const tok = (await res.json()) as TokenResponse
  if (!tok.access_token) throw new Error('token response missing access_token')
  return tok
}

// ---------------------------------------------------------------------------
// Loopback authorization listener (I/O)
// ---------------------------------------------------------------------------
export interface LoopbackResult {
  code: string
  /** The exact port the listener bound (embedded in the redirect URI). */
  port: number
}

/** Start a loopback HTTP listener on 127.0.0.1:<random high port>, resolve when
 *  the OAuth provider redirects back with a code whose state matches. Enforces:
 *  single-use (first valid callback wins, then the server closes), a hard
 *  timeout, exact path, and state binding. The listener is ALWAYS torn down.
 *
 *  onReady(port) is invoked once the port is known so the caller can build the
 *  redirect URI + open the browser. */
export function awaitLoopbackCode(a: {
  expectedState: string
  timeoutMs?: number
  onReady: (port: number, redirectUri: string) => void | Promise<void>
}): Promise<LoopbackResult> {
  const timeoutMs = a.timeoutMs ?? 120_000
  return new Promise<LoopbackResult>((resolve, reject) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? '/'
      // Only the exact callback path is honored; anything else is a 404 (favicon,
      // probes) and must NOT settle the flow.
      if (!url.startsWith('/callback')) {
        res.writeHead(404).end()
        return
      }
      const parsed = parseCallbackQuery(url)
      if (parsed.error) {
        respond(res, 400, `Authorization failed: ${parsed.error}`)
        finish(new Error(`authorization error: ${parsed.error}`))
        return
      }
      if (!parsed.state || !safeEqual(parsed.state, a.expectedState)) {
        respond(res, 400, 'State mismatch — request rejected.')
        finish(new Error('state mismatch'))
        return
      }
      if (!parsed.code) {
        respond(res, 400, 'No authorization code returned.')
        finish(new Error('missing code'))
        return
      }
      respond(res, 200, 'Linear connected. You can close this tab and return to Agent IDE.')
      const port = addrPort()
      finish(null, { code: parsed.code, port })
    })

    const finish = (err: Error | null, ok?: LoopbackResult) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      // Tear the listener down unconditionally.
      try { server.close() } catch { /* ignore */ }
      if (err) reject(err)
      else resolve(ok!)
    }

    const addrPort = (): number => {
      const addr = server.address()
      return addr && typeof addr === 'object' ? addr.port : 0
    }

    server.on('error', (err) => finish(err instanceof Error ? err : new Error(String(err))))

    // Bind to a random high port on the loopback interface only.
    server.listen(0, '127.0.0.1', () => {
      const port = addrPort()
      const redirectUri = loopbackRedirectUri(port)
      timer = setTimeout(() => finish(new Error('authorization timed out')), timeoutMs)
      // Fire onReady AFTER the timer is armed so a fast browser can't race it.
      Promise.resolve(a.onReady(port, redirectUri)).catch((err) => finish(err as Error))
    })
  })
}

function respond(res: ServerResponse, status: number, message: string): void {
  const safe = message.replace(/[<>&]/g, '')
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(safe)
}

/** A session-id marker embedded in write-back comments so a retry after an
 *  UNKNOWN outcome can look the comment up remotely before re-posting (R23
 *  idempotency). Deterministic + collision-resistant per (session, item, action). */
export function commentIdempotencyMarker(a: { sessionId: string; itemId: string; action: string }): string {
  const h = createHmac('sha256', 'agentide-linear-writeback')
    .update(`${a.sessionId} ${a.itemId} ${a.action}`)
    .digest('hex')
    .slice(0, 16)
  return `⟦agentide:${h}⟧`
}
