import { ipcMain } from 'electron'
import type { IpcDeps } from './deps'
import { NOT_IMPLEMENTED } from './deps'
import { gitStatusSummary, gitWorkingDiff } from '../gitInfo'
import type { GitStatusSummary, GitDiff } from '@shared/types'

/** Git awareness + read-only diff (S4). Snapshot/rollback/undo (#9) are DEFERRED
 *  this run (SNAPSHOT scope decision) — snapshot:list / git:rollbackPreview /
 *  git:rollbackApply stay not-implemented stubs. This registrar implements only
 *  the two read-only handlers: git:status (branch/dirty badge) and git:diff
 *  (working-tree diff pane). Every call resolves the project's confined root from
 *  the Store via deps.projectRoot (main-owned, C-5) — a renderer never supplies a
 *  path. Non-repos return null (never throw). */
export function registerGitIpc({ projectRoot }: IpcDeps): void {
  ipcMain.handle('git:status', async (_e, projectId: unknown): Promise<GitStatusSummary | null> => {
    if (typeof projectId !== 'string') return null
    const root = projectRoot(projectId)
    if (!root) return null
    return gitStatusSummary(root)
  })

  ipcMain.handle('git:diff', async (_e, projectId: unknown): Promise<GitDiff | null> => {
    if (typeof projectId !== 'string') return null
    const root = projectRoot(projectId)
    if (!root) return null
    return gitWorkingDiff(root)
  })

  // DEFERRED (#9 snapshot/rollback/undo) — frozen inert stubs, not implemented.
  ipcMain.handle('snapshot:list', () => NOT_IMPLEMENTED)
  ipcMain.handle('git:rollbackPreview', () => NOT_IMPLEMENTED)
  ipcMain.handle('git:rollbackApply', () => NOT_IMPLEMENTED)
}
