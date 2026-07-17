import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import {
  generateCodeVerifier, codeChallengeS256, generateState, safeEqual,
  validateAuthServerMetadata, buildAuthorizeUrl, parseCallbackQuery,
  loopbackRedirectUri, redact, commentIdempotencyMarker,
  type AuthServerMetadata
} from '../../src/main/linear/oauth'

const META: AuthServerMetadata = {
  issuer: 'https://auth.linear.app',
  authorization_endpoint: 'https://auth.linear.app/oauth/authorize',
  token_endpoint: 'https://auth.linear.app/oauth/token',
  registration_endpoint: 'https://auth.linear.app/oauth/register',
  code_challenge_methods_supported: ['S256']
}

describe('PKCE helpers', () => {
  it('verifier is unreserved-set and 43-128 chars', () => {
    for (let i = 0; i < 20; i++) {
      const v = generateCodeVerifier()
      expect(v.length).toBeGreaterThanOrEqual(43)
      expect(v.length).toBeLessThanOrEqual(128)
      expect(v).toMatch(/^[A-Za-z0-9\-._~]+$/)
    }
  })

  it('S256 challenge matches base64url(sha256(verifier))', () => {
    const v = 'test-verifier-123'
    const expected = createHash('sha256').update(v).digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(codeChallengeS256(v)).toBe(expected)
  })

  it('state is high-entropy and unique', () => {
    const s = new Set(Array.from({ length: 100 }, () => generateState()))
    expect(s.size).toBe(100)
  })

  it('safeEqual is true for equal, false otherwise (constant-time)', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
    // @ts-expect-error deliberately wrong types
    expect(safeEqual(undefined, 'x')).toBe(false)
  })
})

describe('validateAuthServerMetadata', () => {
  it('accepts a well-formed S256 metadata doc', () => {
    expect(validateAuthServerMetadata(META).token_endpoint).toBe(META.token_endpoint)
  })
  it('rejects missing endpoints', () => {
    expect(() => validateAuthServerMetadata({ issuer: 'x' })).toThrow(/authorization_endpoint/)
  })
  it('rejects non-https endpoints', () => {
    expect(() => validateAuthServerMetadata({ ...META, token_endpoint: 'http://insecure/token' })).toThrow(/non-https/)
  })
  it('rejects a server that declares PKCE methods without S256', () => {
    expect(() => validateAuthServerMetadata({ ...META, code_challenge_methods_supported: ['plain'] })).toThrow(/S256/)
  })
})

describe('buildAuthorizeUrl', () => {
  it('embeds response_type, PKCE, state, exact redirect + resource', () => {
    const url = new URL(buildAuthorizeUrl({
      meta: META, clientId: 'cid', redirectUri: loopbackRedirectUri(54321),
      state: 'st8', codeChallenge: 'chal', scope: 'read write', resource: 'https://mcp.linear.app/mcp'
    }))
    expect(url.origin + url.pathname).toBe(META.authorization_endpoint)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('cid')
    expect(url.searchParams.get('code_challenge')).toBe('chal')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe('st8')
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:54321/callback')
    expect(url.searchParams.get('resource')).toBe('https://mcp.linear.app/mcp')
    expect(url.searchParams.get('scope')).toBe('read write')
  })
})

describe('parseCallbackQuery', () => {
  it('parses code + state', () => {
    expect(parseCallbackQuery('/callback?code=abc&state=xyz')).toEqual({ code: 'abc', state: 'xyz' })
  })
  it('surfaces an OAuth error', () => {
    const r = parseCallbackQuery('/callback?error=access_denied&error_description=nope')
    expect(r.error).toMatch(/access_denied: nope/)
  })
})

describe('redact', () => {
  it('masks secret-looking keys', () => {
    const out = redact({ authorization: 'Bearer secret', token: 'abc', nested: { refresh_token: 'r' }, ok: 1 }) as any
    expect(out.authorization).toBe('[redacted]')
    expect(out.token).toBe('[redacted]')
    expect(out.nested.refresh_token).toBe('[redacted]')
    expect(out.ok).toBe(1)
  })
  it('strips query/fragment from URLs (may carry code/token)', () => {
    expect(redact('https://auth.linear.app/oauth/token?code=SECRET#frag')).toBe('https://auth.linear.app/oauth/token')
  })
  it('masks long opaque blobs', () => {
    const blob = 'A'.repeat(100)
    expect(String(redact(blob))).toMatch(/^\[opaque:100\]$/)
  })
})

describe('commentIdempotencyMarker', () => {
  it('is deterministic per (session,item,action) and unique across them', () => {
    const a = commentIdempotencyMarker({ sessionId: 's1', itemId: 'i1', action: 'comment' })
    const b = commentIdempotencyMarker({ sessionId: 's1', itemId: 'i1', action: 'comment' })
    const c = commentIdempotencyMarker({ sessionId: 's2', itemId: 'i1', action: 'comment' })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(/^⟦agentide:[0-9a-f]{16}⟧$/)
  })
})
