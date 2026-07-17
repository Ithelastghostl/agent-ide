// Access-token lifecycle for a connected Linear account (S2). Owns refresh with
// rotation, guarded by an in-process per-account mutex so concurrent MCP calls
// never fire two simultaneous refreshes (which would waste one rotation and
// could invalidate the winner). Persists every rotation immediately.

import { refreshToken as doRefresh, revokeToken, type TokenResponse, type FetchLike } from './oauth'
import { LinearTokenStore, type AccountRecord } from './tokenStore'

/** Skew (ms) before nominal expiry at which a token is treated as expired, so a
 *  refresh happens before an in-flight request would be rejected. */
const EXPIRY_SKEW_MS = 60_000

export class LinearTokenManager {
  private store: LinearTokenStore
  private fetch: FetchLike
  /** Per-account refresh mutex (accountId → in-flight refresh promise). */
  private inflight = new Map<string, Promise<AccountRecord>>()

  constructor(opts: { store?: LinearTokenStore; fetch?: FetchLike } = {}) {
    this.store = opts.store ?? new LinearTokenStore()
    this.fetch = opts.fetch ?? fetch
  }

  /** Return a valid access token for the account, refreshing (with rotation +
   *  mutex) if the current one is missing/expired. */
  async accessToken(accountId: string): Promise<string> {
    const rec = this.store.load(accountId)
    if (!rec) throw new Error('account not connected')
    if (!isExpired(rec)) return rec.accessToken
    const refreshed = await this.refresh(accountId)
    return refreshed.accessToken
  }

  /** Force a refresh (rotation) for the account, coalescing concurrent callers. */
  async refresh(accountId: string): Promise<AccountRecord> {
    const existing = this.inflight.get(accountId)
    if (existing) return existing
    const p = this.doRefreshLocked(accountId).finally(() => this.inflight.delete(accountId))
    this.inflight.set(accountId, p)
    return p
  }

  private async doRefreshLocked(accountId: string): Promise<AccountRecord> {
    // Re-read under the lock: a prior coalesced refresh may have just succeeded.
    const rec = this.store.load(accountId)
    if (!rec) throw new Error('account not connected')
    if (!isExpired(rec)) return rec
    if (!rec.refreshToken) throw new Error('no refresh token — reconnect required')

    const tok = await doRefresh({
      meta: rec.meta,
      clientId: rec.client.client_id,
      clientSecret: rec.client.client_secret,
      refreshToken: rec.refreshToken,
      resource: rec.resource,
      f: this.fetch
    })
    const updated = applyToken(rec, tok)
    this.store.save(updated)
    return updated
  }

  /** Logout: revoke (if advertised) then remove the token file. */
  async logout(accountId: string): Promise<{ ok: true; revoked: boolean } | { error: string }> {
    const rec = this.store.load(accountId)
    if (!rec) return { error: 'account not connected' }
    let revoked = false
    try {
      // Revoke the refresh token first (invalidates the whole grant), then access.
      if (rec.refreshToken) {
        revoked = await revokeToken({ meta: rec.meta, clientId: rec.client.client_id, token: rec.refreshToken, tokenTypeHint: 'refresh_token', f: this.fetch }) || revoked
      }
      revoked = await revokeToken({ meta: rec.meta, clientId: rec.client.client_id, token: rec.accessToken, tokenTypeHint: 'access_token', f: this.fetch }) || revoked
    } catch { /* revocation is best-effort; still remove the file */ }
    this.store.remove(accountId)
    return { ok: true, revoked }
  }
}

function isExpired(rec: AccountRecord): boolean {
  if (!rec.expiresAt) return false // no expiry info → treat as long-lived
  return Date.now() >= rec.expiresAt - EXPIRY_SKEW_MS
}

/** Merge a fresh token response into a record WITH rotation (a new refresh_token
 *  replaces the old; absence keeps the previous one, per servers that don't
 *  re-issue). */
export function applyToken(rec: AccountRecord, tok: TokenResponse): AccountRecord {
  return {
    ...rec,
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token ?? rec.refreshToken,
    expiresAt: tok.expires_in ? Date.now() + tok.expires_in * 1000 : undefined,
    scope: tok.scope ?? rec.scope,
    updatedAt: Date.now()
  }
}
