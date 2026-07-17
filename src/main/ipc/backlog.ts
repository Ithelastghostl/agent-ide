import { ipcMain } from 'electron'
import type { IpcDeps } from './deps'
import type { BacklogCreateInput, BacklogUpdateInput } from '@shared/types'

/** Backlog CRUD (implemented in P0). Source authority is enforced in the Store
 *  (R17): create forces source='manual'; linear/generated rows are read-only. */
export function registerBacklogIpc({ store }: IpcDeps): void {
  ipcMain.handle('backlog:list', (_e, projectId: unknown) =>
    typeof projectId === 'string' && store ? store.listBacklog(projectId) : [])

  ipcMain.handle('backlog:create', (_e, raw: unknown) => {
    if (!store) return { error: 'no store' }
    const input = raw as BacklogCreateInput
    if (!input || typeof input.projectId !== 'string' || !store.getProject(input.projectId)) return { error: 'unknown project' }
    if (!['epic', 'goal', 'task', 'ticket'].includes(input.kind)) return { error: 'invalid kind' }
    return store.createBacklogItem({
      projectId: input.projectId, kind: input.kind, title: String(input.title ?? ''),
      bodyMd: input.bodyMd ? String(input.bodyMd) : '', manualStatus: input.manualStatus, parentId: input.parentId ?? null
    })
  })

  ipcMain.handle('backlog:update', (_e, raw: unknown) => {
    if (!store) return { error: 'no store' }
    const input = raw as BacklogUpdateInput
    if (!input || typeof input.id !== 'string') return { error: 'invalid request' }
    return store.updateBacklogItem({
      id: input.id, title: input.title, bodyMd: input.bodyMd, manualStatus: input.manualStatus,
      parentId: input.parentId === undefined ? undefined : input.parentId
    })
  })

  ipcMain.handle('backlog:delete', (_e, id: unknown) =>
    typeof id === 'string' && store ? store.deleteBacklogItem(id) : { error: 'invalid request' })

  // bind/unbind a session ↔ backlog item (used by launch selection + UI unlink)
  ipcMain.handle('backlog:unbind', (_e, sessionId: unknown, itemId: unknown) => {
    if (typeof sessionId !== 'string' || typeof itemId !== 'string' || !store) return { error: 'invalid request' }
    store.unbindSessionBacklog(sessionId, itemId)
    return { ok: true }
  })
  ipcMain.handle('backlog:forSession', (_e, sessionId: unknown) =>
    typeof sessionId === 'string' && store ? store.itemsForSession(sessionId) : [])
}
