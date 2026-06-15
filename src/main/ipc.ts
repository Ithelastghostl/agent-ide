import { ipcMain, type BrowserWindow } from 'electron'
import { PtyManager, type SpawnOpts } from './ptyManager'
import { launchArgv } from './providers'
import { allModels } from './models'
import { isProvider, type Provider, type Session } from '@shared/types'

export interface LaunchRequest {
  projectId: string
  provider: Provider
  model: string
  objective: string
  cwd: string
  autoApprove: boolean
}

let seq = 0
function newSessionId(): string {
  seq += 1
  return `sess-${seq}-${process.pid}`
}

/** Registers all main-process IPC handlers. Thin router — logic lives in managers. */
export function registerIpc(mgr: PtyManager, win: BrowserWindow): void {
  ipcMain.handle('ping', () => 'pong')

  // model registry for the picker
  ipcMain.handle('models:all', () => allModels())

  // terminal pty
  ipcMain.handle('pty:spawn', (_e, o: SpawnOpts) => {
    mgr.spawn(o, (data) => win.webContents.send('pty:data', { id: o.id, data }))
    return o.id
  })
  ipcMain.on('pty:write', (_e, id: string, data: string) => mgr.write(id, data))
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => mgr.resize(id, cols, rows))
  ipcMain.on('pty:kill', (_e, id: string) => mgr.kill(id))

  // launch a real provider session (interactive CLI, subscription-safe per NN0)
  ipcMain.handle('session:launch', (_e, req: LaunchRequest): Session => {
    if (!isProvider(req.provider)) throw new Error(`bad provider: ${req.provider}`)
    const id = newSessionId()
    const { cmd, args } = launchArgv({ provider: req.provider, model: req.model, autoApprove: req.autoApprove })
    mgr.spawn(
      { id, shell: cmd, args, cwd: req.cwd, env: {} },
      (data) => win.webContents.send('pty:data', { id, data })
    )
    const now = Date.now()
    return {
      id,
      projectId: req.projectId,
      provider: req.provider,
      model: req.model,
      objective: req.objective || `${req.provider} session`,
      status: 'running',
      createdAt: now,
      updatedAt: now
    }
  })
}
