import { ipcMain } from 'electron'
import type { IpcDeps } from './deps'
import type { BacklogCreateInput, BacklogUpdateInput } from '@shared/types'
import type { Store } from '../store'
import { BacklogInbox } from '../backlogInbox'

// Max backlog items bindable to one launch (primer cap, R21-minor). Mirrors the
// queue-launch cap in ipc/queue.ts.
const MAX_BOUND = 5

// One inbox manager per app run: watches every project's backlog/inbox and
// ingests dropped markdown files (S1). Started when the registrar first runs
// with a live store.
let inbox: BacklogInbox | undefined

/** Bind a "Work on this" selection to a session (S1). Validates that every item
 *  belongs to the session's project and enforces the 5-item cap; binding moves
 *  each item to sessionState 'in-session' (Store recompute). Called from the
 *  launch handlers (session:launch / terminal:open) after the row is persisted. */
export function bindLaunchBacklog(
  store: Store,
  sessionId: string,
  projectId: string,
  raw: unknown
): { ok?: true; error?: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: true }
  const ids = raw.filter((x): x is string => typeof x === 'string')
  if (ids.length > MAX_BOUND) return { error: `at most ${MAX_BOUND} backlog items per launch` }
  // Only bind items that exist in the SAME project (main-owned ownership check).
  const valid = ids.filter((id) => store.getBacklogItem(id)?.projectId === projectId)
  if (valid.length) store.bindSessionBacklog(sessionId, valid)
  return { ok: true }
}

/** Backlog CRUD (implemented in P0). Source authority is enforced in the Store
 *  (R17): create forces source='manual'; linear/generated rows are read-only. S1
 *  adds inbox ingestion + explicit session binding. */
export function registerBacklogIpc({ store }: IpcDeps): void {
  ipcMain.handle('backlog:list', (_e, projectId: unknown) =>
    typeof projectId === 'string' && store ? store.listBacklog(projectId) : []
  )

  ipcMain.handle('backlog:create', (_e, raw: unknown) => {
    if (!store) return { error: 'no store' }
    const input = raw as BacklogCreateInput
    if (!input || typeof input.projectId !== 'string' || !store.getProject(input.projectId))
      return { error: 'unknown project' }
    if (!['epic', 'goal', 'task', 'ticket'].includes(input.kind)) return { error: 'invalid kind' }
    return store.createBacklogItem({
      projectId: input.projectId,
      kind: input.kind,
      title: String(input.title ?? ''),
      bodyMd: input.bodyMd ? String(input.bodyMd) : '',
      manualStatus: input.manualStatus,
      parentId: input.parentId ?? null
    })
  })

  ipcMain.handle('backlog:update', (_e, raw: unknown) => {
    if (!store) return { error: 'no store' }
    const input = raw as BacklogUpdateInput
    if (!input || typeof input.id !== 'string') return { error: 'invalid request' }
    return store.updateBacklogItem({
      id: input.id,
      title: input.title,
      bodyMd: input.bodyMd,
      manualStatus: input.manualStatus,
      parentId: input.parentId === undefined ? undefined : input.parentId
    })
  })

  ipcMain.handle('backlog:delete', (_e, id: unknown) =>
    typeof id === 'string' && store ? store.deleteBacklogItem(id) : { error: 'invalid request' }
  )

  // Bind a "Work on this" selection to an existing session (S1). Complements the
  // launch-time binding for selections made against an already-running session.
  ipcMain.handle('backlog:bind', (_e, sessionId: unknown, itemIds: unknown) => {
    if (typeof sessionId !== 'string' || !store) return { error: 'invalid request' }
    const s = store.getSession(sessionId)
    if (!s) return { error: 'unknown session' }
    return bindLaunchBacklog(store, sessionId, s.projectId, itemIds)
  })

  // bind/unbind a session ↔ backlog item (used by launch selection + UI unlink)
  ipcMain.handle('backlog:unbind', (_e, sessionId: unknown, itemId: unknown) => {
    if (typeof sessionId !== 'string' || typeof itemId !== 'string' || !store)
      return { error: 'invalid request' }
    store.unbindSessionBacklog(sessionId, itemId)
    return { ok: true }
  })
  ipcMain.handle('backlog:forSession', (_e, sessionId: unknown) =>
    typeof sessionId === 'string' && store ? store.itemsForSession(sessionId) : []
  )

  // S1: start the inbox watcher(s) once per app run (idempotent). Kept here so
  // the wiring lives inside the backlog stream's own registrar.
  if (store && !inbox) {
    inbox = new BacklogInbox(store)
    inbox.start()
  }
}
