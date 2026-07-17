import { ipcMain } from 'electron'
import type { IpcDeps } from './deps'
import { NOT_IMPLEMENTED } from './deps'

/** Attention monitor + cost telemetry (S5). Foundation stubs; S5 implements the
 *  event-bus output monitor, ephemeral attention badges, and cost parsing.
 *  session:handoff (split-view context handoff, S6) also stubs here until S6. */
export function registerAttentionIpc(_deps: IpcDeps): void {
  ipcMain.handle('attention:state', () => ({})) // {sessionId: 'input'|'idle'} — empty until S5
  ipcMain.handle('cost:forSession', () => NOT_IMPLEMENTED)
  ipcMain.handle('session:handoff', () => NOT_IMPLEMENTED)
}
