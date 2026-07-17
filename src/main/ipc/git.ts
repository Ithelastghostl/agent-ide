import { ipcMain } from 'electron'
import type { IpcDeps } from './deps'
import { NOT_IMPLEMENTED } from './deps'

/** Git awareness + read-only diff (S4). Foundation stubs; S4 implements
 *  git:status / git:diff. Snapshot/rollback are DEFERRED this run (SNAPSHOT
 *  scope decision) — their handlers stay not-implemented. */
export function registerGitIpc(_deps: IpcDeps): void {
  ipcMain.handle('git:status', () => NOT_IMPLEMENTED)
  ipcMain.handle('git:diff', () => NOT_IMPLEMENTED)
  ipcMain.handle('snapshot:list', () => NOT_IMPLEMENTED)
  ipcMain.handle('git:rollbackPreview', () => NOT_IMPLEMENTED)
  ipcMain.handle('git:rollbackApply', () => NOT_IMPLEMENTED)
}
