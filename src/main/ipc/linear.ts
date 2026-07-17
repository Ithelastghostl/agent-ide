import { ipcMain } from 'electron'
import type { IpcDeps } from './deps'
import { safeOpenExternal } from '../ipc'
import { LinearService, type WritebackAction } from '../linear/linearService'
import { linearLog, redact } from '../linear/oauth'

/** Linear per-project MCP integration (S2). Full OAuth 2.1 + Streamable-HTTP MCP
 *  client, pull, and idempotent write-back. The service is constructed once per
 *  registrar with the store + the safe browser-open choke point. */
export function registerLinearIpc(deps: IpcDeps): void {
  const svc = new LinearService({ store: deps.store, openExternal: safeOpenExternal })

  /** status(projectId) → connection + link summary (no secrets). */
  ipcMain.handle('linear:status', (_e, projectId: unknown) => {
    if (typeof projectId !== 'string') return { connected: false, error: 'invalid request' }
    return svc.status(projectId)
  })

  /** link(projectId, ref) → store the LinearLink. If ref omits accountId, run the
   *  OAuth flow first and link to the discovered account. */
  ipcMain.handle('linear:link', async (_e, projectId: unknown, ref: unknown) => {
    if (typeof projectId !== 'string') return { error: 'invalid request' }
    try {
      let link = ref
      const asObj = (ref ?? {}) as { accountId?: unknown }
      if (!asObj || typeof asObj.accountId !== 'string') {
        // No account supplied → connect, then merge the discovered identity.
        const identity = await svc.connect()
        link = { ...(typeof ref === 'object' && ref ? ref : {}), accountId: identity.accountId, workspaceId: identity.workspaceId }
      }
      return svc.link(projectId, link)
    } catch (err) {
      linearLog('link failed', redact({ message: (err as Error).message }))
      return { error: (err as Error).message }
    }
  })

  /** pull(projectId) → paginated issues → backlog upsert. */
  ipcMain.handle('linear:pull', async (_e, projectId: unknown) => {
    if (typeof projectId !== 'string') return { error: 'invalid request' }
    try {
      return await svc.pull(projectId)
    } catch (err) {
      linearLog('pull failed', redact({ message: (err as Error).message }))
      return { error: (err as Error).message }
    }
  })

  /** writeback(itemId, action) → PREVIEW then APPLY over the single frozen
   *  channel. action.mode='preview' returns the exact target/comment for the UI
   *  modal WITHOUT mutating; action.mode='apply' (default) performs the
   *  idempotent write-back. A sessionId marker (comment idempotency) may ride on
   *  the action payload. */
  ipcMain.handle('linear:writeback', async (_e, itemId: unknown, action: unknown) => {
    if (typeof itemId !== 'string') return { error: 'invalid request' }
    const parsed = parseAction(action)
    if ('error' in parsed) return parsed
    try {
      if (parsed.mode === 'preview') return await svc.previewWriteback(itemId, parsed.action)
      return await svc.applyWriteback(itemId, parsed.action, parsed.sessionId)
    } catch (err) {
      linearLog('writeback failed', redact({ message: (err as Error).message }))
      return { error: (err as Error).message }
    }
  })

  /** logout(accountId) → revoke (if advertised) + remove the token file. */
  ipcMain.handle('linear:logout', async (_e, accountId: unknown) => {
    if (typeof accountId !== 'string') return { error: 'invalid request' }
    try {
      return await svc.logout(accountId)
    } catch (err) {
      linearLog('logout failed', redact({ message: (err as Error).message }))
      return { error: (err as Error).message }
    }
  })
}

/** Validate + normalize a write-back action payload from the renderer. */
export function parseAction(raw: unknown): { action: WritebackAction; sessionId: string; mode: 'preview' | 'apply' } | { error: string } {
  const r = raw as { kind?: unknown; text?: unknown; sessionId?: unknown; mode?: unknown }
  if (!r || typeof r !== 'object' || typeof r.kind !== 'string') return { error: 'invalid action' }
  const sessionId = typeof r.sessionId === 'string' ? r.sessionId : 'no-session'
  const mode: 'preview' | 'apply' = r.mode === 'preview' ? 'preview' : 'apply'
  if (r.kind === 'started' || r.kind === 'done') return { action: { kind: r.kind }, sessionId, mode }
  if (r.kind === 'comment') {
    if (typeof r.text !== 'string' || !r.text.trim()) return { error: 'comment text required' }
    return { action: { kind: 'comment', text: r.text }, sessionId, mode }
  }
  return { error: `unknown action kind: ${r.kind}` }
}
