import { ipcMain } from 'electron'
import type { IpcDeps } from './deps'
import type { QueueItem } from '@shared/types'
import { isProvider } from '@shared/types'

/** Queue CRUD (implemented in P0). The advancement TRIGGER (auto-advance on
 *  archive) is wired by S6 via sessionEvents; the launchService.launchNextQueued
 *  path itself is foundation-owned. */
export function registerQueueIpc({ store, launch }: IpcDeps): void {
  ipcMain.handle('queue:list', (_e, projectId: unknown) =>
    typeof projectId === 'string' && store ? store.listQueue(projectId) : [])

  ipcMain.handle('queue:enqueue', async (_e, raw: unknown) => {
    if (!store) return { error: 'no store' }
    const q = raw as Partial<QueueItem>
    if (!q || typeof q.projectId !== 'string' || !store.getProject(q.projectId)) return { error: 'unknown project' }
    if (!isProvider(String(q.provider))) return { error: 'invalid provider' }
    if (!q.objective || !String(q.objective).trim()) return { error: 'objective required' }
    if (Array.isArray(q.backlogItemIds) && q.backlogItemIds.length > 5) return { error: 'at most 5 backlog items per launch' }
    const item = store.enqueue({
      projectId: q.projectId, objective: String(q.objective), provider: q.provider!, model: String(q.model ?? ''),
      useContainer: !!q.useContainer, taskKind: q.taskKind ?? null, taskSubkind: q.taskSubkind ?? null,
      agentRelPath: q.agentRelPath ?? null, backlogItemIds: Array.isArray(q.backlogItemIds) ? q.backlogItemIds : []
    })
    // Non-completion wake-up (R21): enqueue may launch immediately for an eligible
    // idle project. Fire-and-forget through the gated advancement path.
    void launch.launchNextQueued(q.projectId)
    return { item }
  })

  ipcMain.handle('queue:delete', (_e, id: unknown) => {
    if (typeof id !== 'string' || !store) return { error: 'invalid request' }
    store.deleteQueueItem(id)
    return { ok: true }
  })

  ipcMain.handle('queue:reorder', (_e, projectId: unknown, orderedIds: unknown) => {
    if (typeof projectId !== 'string' || !Array.isArray(orderedIds) || !store) return { error: 'invalid request' }
    store.reorderQueue(projectId, orderedIds.filter((x): x is string => typeof x === 'string'))
    return { ok: true }
  })

  // Explicit "Start next" (R21) — advances regardless of the autoAdvance setting.
  ipcMain.handle('queue:startNext', async (_e, projectId: unknown) => {
    if (typeof projectId !== 'string') return { error: 'invalid request' }
    const s = await launch.launchNextQueued(projectId)
    return s ? { ok: true, sessionId: s.id } : { ok: true, sessionId: null }
  })
}
