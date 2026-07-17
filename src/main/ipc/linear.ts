import { ipcMain } from 'electron'
import type { IpcDeps } from './deps'
import { NOT_IMPLEMENTED } from './deps'

/** Linear per-project MCP integration (S2). Foundation stubs; S2 implements the
 *  full OAuth 2.1 + Streamable-HTTP MCP client, pull, and write-back. */
export function registerLinearIpc(_deps: IpcDeps): void {
  ipcMain.handle('linear:status', () => NOT_IMPLEMENTED)
  ipcMain.handle('linear:link', () => NOT_IMPLEMENTED)
  ipcMain.handle('linear:pull', () => NOT_IMPLEMENTED)
  ipcMain.handle('linear:writeback', () => NOT_IMPLEMENTED)
  ipcMain.handle('linear:logout', () => NOT_IMPLEMENTED)
}
