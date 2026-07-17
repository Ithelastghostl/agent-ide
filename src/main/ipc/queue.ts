import { ipcMain } from 'electron'
import type { IpcDeps } from './deps'
import type { QueueItem } from '@shared/types'
import { isProvider } from '@shared/types'
import { sessionEvents } from '../sessionEvents'
import { getAutoAdvance, setAutoAdvance } from './autoAdvance'

/** Queue CRUD (implemented in P0) + S6 wiring. The queue CONSUMPTION logic
 *  (claimNext, launchNextQueued/Admitted, boot recovery, exactly-once) is
 *  foundation-owned; S6 wires only the UI-facing handlers and the advancement
 *  TRIGGERS it is responsible for:
 *   - completion trigger: the sessionEvents 'archived' event → launchNextQueued
 *     when the project has autoAdvance on (the sole session-COMPLETION trigger, R31).
 *   - non-completion wake-ups (R21): enqueue into an eligible idle project, and
 *     autoAdvance false→true — both go through the public gated launchNextQueued.
 *   - explicit "Start next" (already wired below), which advances regardless.
 *  autoAdvance is an S6-owned per-project flag (see ./autoAdvance) because the
 *  foundation projects schema/Store are frozen and do not carry it. */
export function registerQueueIpc({ store, launch, send }: IpcDeps): void {
  ipcMain.handle('queue:list', (_e, projectId: unknown) =>
    typeof projectId === 'string' && store ? store.listQueue(projectId) : [])

  ipcMain.handle('queue:enqueue', async (_e, raw: unknown) => {
    if (!store) return { error: 'no store' }
    const q = raw as Partial<QueueItem>
    if (!q || typeof q.projectId !== 'string' || !store.getProject(q.projectId)) return { error: 'unknown project' }
    if (!isProvider(String(q.provider))) return { error: 'invalid provider' }
    if (!q.objective || !String(q.objective).trim()) return { error: 'objective required' }
    // Binding more than the 5-item primer cap is REJECTED at selection (R21-minor).
    if (Array.isArray(q.backlogItemIds) && q.backlogItemIds.length > 5) return { error: 'at most 5 backlog items per launch' }
    const item = store.enqueue({
      projectId: q.projectId, objective: String(q.objective), provider: q.provider!, model: String(q.model ?? ''),
      useContainer: !!q.useContainer, taskKind: q.taskKind ?? null, taskSubkind: q.taskSubkind ?? null,
      agentRelPath: q.agentRelPath ?? null, backlogItemIds: Array.isArray(q.backlogItemIds) ? q.backlogItemIds : []
    })
    // Non-completion wake-up (R21/R23-minor): an idle-project ENQUEUE auto-launches
    // ONLY when autoAdvance is enabled. Fire-and-forget through the gated path.
    if (getAutoAdvance(q.projectId)) void advanceAndNotify(q.projectId)
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

  // Explicit "Start next" (R21/R23-minor) — advances regardless of the autoAdvance
  // setting; the launch is still gated + exactly-once via claimNext.
  ipcMain.handle('queue:startNext', async (_e, projectId: unknown) => {
    if (typeof projectId !== 'string') return { error: 'invalid request' }
    const s = await launch.launchNextQueued(projectId)
    send('queue:changed', { projectId })
    return { ok: true, sessionId: s ? s.id : null }
  })

  // --- autoAdvance toggle (S6-owned flag) --------------------------------------
  ipcMain.handle('queue:getAutoAdvance', (_e, projectId: unknown) =>
    typeof projectId === 'string' ? getAutoAdvance(projectId) : false)

  ipcMain.handle('queue:setAutoAdvance', async (_e, projectId: unknown, on: unknown) => {
    if (typeof projectId !== 'string') return { error: 'invalid request' }
    const prev = setAutoAdvance(projectId, on === true)
    // R21 non-completion wake-up: enabling autoAdvance with pending work launches.
    if (on === true && !prev) void advanceAndNotify(projectId)
    return { ok: true, autoAdvance: on === true }
  })

  // --- completion trigger: advance on a committed 'archived' event (R31) -------
  // The archive/advancement exactly-once + gate serialization lives in the
  // foundation; S6 only decides WHETHER to advance (autoAdvance on) and routes
  // through the public gated path. A no-op when the project isn't eligible.
  sessionEvents.onEvent('archived', ({ projectId }) => {
    send('queue:changed', { projectId })
    if (getAutoAdvance(projectId)) void advanceAndNotify(projectId)
  })

  /** Advance the queue (gated, exactly-once) then tell the renderer to refresh. */
  async function advanceAndNotify(projectId: string): Promise<void> {
    try { await launch.launchNextQueued(projectId) } finally { send('queue:changed', { projectId }) }
  }
}
