import { ipcMain, type BrowserWindow } from 'electron'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PtyManager, type SpawnOpts } from './ptyManager'
import { launchArgv } from './providers'
import { allModels } from './models'
import { addProject } from './projects'
import { listRepos } from './github'
import { isProvider, type Provider, type Session } from '@shared/types'

export interface FileNode {
  name: string
  dir: boolean
  depth: number
}

/** Shallow, one-level-deep file tree for the explorer (dirs first, alpha). */
export function readTree(root: string): FileNode[] {
  try {
    const entries = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.name !== '.git')
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    const out: FileNode[] = []
    for (const e of entries) {
      out.push({ name: e.name, dir: e.isDirectory(), depth: 0 })
      if (e.isDirectory()) {
        try {
          for (const c of readdirSync(join(root, e.name), { withFileTypes: true })
            .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
            .slice(0, 12)) {
            out.push({ name: c.name, dir: c.isDirectory(), depth: 1 })
          }
        } catch {
          /* unreadable subdir */
        }
      }
    }
    return out
  } catch {
    return []
  }
}

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

  // projects (GitHub-synced)
  ipcMain.handle('github:repos', () => listRepos())
  ipcMain.handle('projects:add', (_e, repo: string) => addProject(repo))
  ipcMain.handle('fs:tree', (_e, root: string) => readTree(root))

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
