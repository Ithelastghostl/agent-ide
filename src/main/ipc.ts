import { ipcMain, type BrowserWindow } from 'electron'
import { PtyManager, type SpawnOpts } from './ptyManager'

/** Registers all main-process IPC handlers. Thin router — logic lives in managers. */
export function registerIpc(mgr: PtyManager, win: BrowserWindow): void {
  ipcMain.handle('ping', () => 'pong')

  // Spawn a pty; stream its output to the renderer tagged with the session id.
  ipcMain.handle('pty:spawn', (_e, o: SpawnOpts) => {
    mgr.spawn(o, (data) => {
      win.webContents.send('pty:data', { id: o.id, data })
    })
    return o.id
  })

  ipcMain.on('pty:write', (_e, id: string, data: string) => mgr.write(id, data))
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => mgr.resize(id, cols, rows))
  ipcMain.on('pty:kill', (_e, id: string) => mgr.kill(id))
}
