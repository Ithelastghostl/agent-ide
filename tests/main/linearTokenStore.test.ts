import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir, platform } from 'node:os'
import { join } from 'node:path'
import { LinearTokenStore, LinearLinkStore, accountFileStem, authRoot, type AccountRecord } from '../../src/main/linear/tokenStore'
import { LinearTokenManager, applyToken } from '../../src/main/linear/tokenManager'
import type { AuthServerMetadata } from '../../src/main/linear/oauth'

const META: AuthServerMetadata = {
  issuer: 'https://auth.linear.app',
  authorization_endpoint: 'https://auth.linear.app/authorize',
  token_endpoint: 'https://auth.linear.app/token',
  revocation_endpoint: 'https://auth.linear.app/revoke'
}

function rec(id = 'acct-1'): AccountRecord {
  return {
    accountId: id, workspaceId: 'ws-1', meta: META,
    client: { client_id: 'cid' }, accessToken: 'at', refreshToken: 'rt',
    resource: 'https://mcp.linear.app/mcp', createdAt: Date.now(), updatedAt: Date.now()
  }
}

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'agide-linear-')); process.env.AGENT_IDE_LINEAR_AUTH = dir })
afterEach(() => { delete process.env.AGENT_IDE_LINEAR_AUTH; rmSync(dir, { recursive: true, force: true }) })

describe('LinearTokenStore', () => {
  it('filename is sha256(accountId) — no raw id on disk', () => {
    const store = new LinearTokenStore()
    store.save(rec('secret-account-id'))
    const stem = accountFileStem('secret-account-id')
    expect(existsSync(join(dir, `${stem}.json`))).toBe(true)
    // the raw account id must NOT appear in any filename
    expect(existsSync(join(dir, 'secret-account-id.json'))).toBe(false)
  })

  it('round-trips a record', () => {
    const store = new LinearTokenStore()
    store.save(rec())
    const loaded = store.load('acct-1')
    expect(loaded?.workspaceId).toBe('ws-1')
    expect(loaded?.accessToken).toBe('at')
  })

  it('directory is 0700 and files are 0600 (posix)', () => {
    const store = new LinearTokenStore()
    store.save(rec())
    if (platform() !== 'win32') {
      expect(statSync(authRoot()).mode & 0o777).toBe(0o700)
      expect(statSync(join(dir, `${accountFileStem('acct-1')}.json`)).mode & 0o777).toBe(0o600)
    }
  })

  it('remove() deletes the file (logout)', () => {
    const store = new LinearTokenStore()
    store.save(rec())
    expect(store.has('acct-1')).toBe(true)
    expect(store.remove('acct-1')).toBe(true)
    expect(store.has('acct-1')).toBe(false)
  })

  it('rejects a symlinked token path', () => {
    if (platform() === 'win32') return
    const store = new LinearTokenStore()
    const target = join(dir, 'elsewhere.json')
    writeFileSync(target, '{}')
    symlinkSync(target, join(dir, `${accountFileStem('acct-1')}.json`))
    expect(() => store.save(rec())).toThrow(/symlink/)
  })

  it('list() enumerates connected accounts', () => {
    const store = new LinearTokenStore()
    store.save(rec('a')); store.save(rec('b'))
    expect(store.list().map((r) => r.accountId).sort()).toEqual(['a', 'b'])
  })
})

describe('LinearLinkStore', () => {
  it('round-trips a per-project link', () => {
    const store = new LinearLinkStore()
    store.set('p1', { accountId: 'a', workspaceId: 'ws', teamId: 't', projectId: null, label: 'My team' })
    expect(store.get('p1')?.label).toBe('My team')
    expect(store.get('p1')?.teamId).toBe('t')
    expect(store.get('missing')).toBeUndefined()
  })
})

describe('LinearTokenManager', () => {
  it('returns the current token when not expired', async () => {
    const store = new LinearTokenStore()
    store.save({ ...rec(), expiresAt: Date.now() + 3_600_000 })
    const mgr = new LinearTokenManager({ store })
    expect(await mgr.accessToken('acct-1')).toBe('at')
  })

  it('refreshes with rotation when expired, and coalesces concurrent refreshes', async () => {
    const store = new LinearTokenStore()
    store.save({ ...rec(), expiresAt: Date.now() - 1000 }) // already expired
    let calls = 0
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      calls++
      expect(String(init?.body)).toContain('grant_type=refresh_token')
      // simulate latency so concurrent callers overlap
      await new Promise((r) => setTimeout(r, 10))
      return jsonResponse({ access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600, token_type: 'Bearer' })
    }) as unknown as typeof fetch
    const mgr = new LinearTokenManager({ store, fetch: fakeFetch })

    const [a, b, c] = await Promise.all([mgr.accessToken('acct-1'), mgr.accessToken('acct-1'), mgr.accessToken('acct-1')])
    expect([a, b, c]).toEqual(['AT2', 'AT2', 'AT2'])
    expect(calls).toBe(1) // single refresh despite three concurrent callers
    // rotation persisted
    expect(store.load('acct-1')?.refreshToken).toBe('RT2')
    expect(store.load('acct-1')?.accessToken).toBe('AT2')
  })

  it('logout revokes (advertised) then removes the file', async () => {
    const store = new LinearTokenStore()
    store.save(rec())
    const revoked: string[] = []
    const fakeFetch = (async (url: string) => { revoked.push(url); return jsonResponse({}) }) as unknown as typeof fetch
    const mgr = new LinearTokenManager({ store, fetch: fakeFetch })
    const r = await mgr.logout('acct-1')
    expect('ok' in r && r.ok).toBe(true)
    expect(revoked.length).toBeGreaterThanOrEqual(1)
    expect(store.has('acct-1')).toBe(false)
  })
})

describe('applyToken rotation', () => {
  it('keeps the old refresh token when the server omits a new one', () => {
    const updated = applyToken(rec(), { access_token: 'new', token_type: 'Bearer', expires_in: 100 })
    expect(updated.accessToken).toBe('new')
    expect(updated.refreshToken).toBe('rt') // preserved
    expect(updated.expiresAt).toBeGreaterThan(Date.now())
  })
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
