import { ipcMain, dialog, type BrowserWindow } from 'electron'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { PtyManager, type SpawnOpts } from './ptyManager'
import { launchArgv, resumeArgv } from './providers'
import { allModels } from './models'
import { addProject, addProjectFromUrl, openLocalProject } from './projects'
import { listRepos, syncHistory } from './github'
import { upDevcontainer, containerExecArgv, hasDevcontainerCli, claudeConfigMount } from './devcontainer'
import { probeHealth, loginArgv, installInContainer } from './providerHealth'
import { Store } from './store'
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
  /** When true, run the session inside the project's devcontainer (NN2). The
   *  renderer decides this now (F11 — asks the user host vs container). */
  useContainer: boolean
  /** F12: bind-mount ~/.claude (read-only) into the container on first build. */
  importConfig?: boolean
}

let seq = 0
function newSessionId(): string {
  seq += 1
  return `sess-${seq}-${process.pid}`
}

// One container per project, brought up lazily and reused across its sessions.
const containerByProject = new Map<string, string>()
async function ensureContainer(projectId: string, workspace: string, importConfig = false): Promise<string> {
  const existing = containerByProject.get(projectId)
  if (existing) return existing
  const mounts = importConfig ? [claudeConfigMount(homedir())] : []
  const { containerId } = await upDevcontainer(workspace, mounts)
  containerByProject.set(projectId, containerId)
  return containerId
}

/** Resolve the container id for a project if one is already up (for health/login
 *  in container context), else undefined. */
function containerIdFor(projectId: string): string | undefined {
  return containerByProject.get(projectId)
}

/** Registers all main-process IPC handlers. Thin router — logic lives in managers.
 *  `store` may be undefined if persistence failed to initialize; handlers then
 *  no-op writes and return empty reads so the UI still works. */
export function registerIpc(mgr: PtyManager, win: BrowserWindow, store?: Store): void {
  ipcMain.handle('ping', () => 'pong')

  // model registry for the picker
  ipcMain.handle('models:all', () => allModels())

  // native directory picker (F2)
  ipcMain.handle('dialog:openDirectory', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })

  // projects — persisted to the store. Three add paths (F2):
  ipcMain.handle('github:repos', () => listRepos())
  ipcMain.handle('projects:addGithub', async (_e, repo: string, parentDir?: string) => {
    const p = parentDir ? await addProject(repo, parentDir) : await addProject(repo)
    store?.saveProject(p)
    return p
  })
  ipcMain.handle('projects:addLocal', (_e, localPath: string) => {
    const p = openLocalProject(localPath)
    store?.saveProject(p)
    return p
  })
  ipcMain.handle('projects:addUrl', async (_e, url: string, parentDir: string) => {
    const p = await addProjectFromUrl(url, parentDir)
    store?.saveProject(p)
    return p
  })
  ipcMain.handle('projects:list', () => store?.listProjects() ?? [])
  ipcMain.handle('fs:tree', (_e, root: string) => readTree(root))

  // rename a session (F3/F6)
  ipcMain.handle('session:rename', (_e, id: string, name: string) => {
    store?.renameSession(id, name)
  })

  // close + archive a session: kill its pty and persist archived status (F6).
  ipcMain.handle('session:archive', (_e, id: string) => {
    mgr.kill(id)
    store?.archiveSession(id)
  })

  // F8: provider connection health, in the project's context (host or container).
  ipcMain.handle('provider:health', async (_e, provider: Provider, projectId: string) => {
    if (!isProvider(provider)) throw new Error(`bad provider: ${provider}`)
    const containerId = containerIdFor(projectId)
    return probeHealth(provider, { containerId })
  })

  // F10: run an interactive CLI login as a terminal session, in project context.
  ipcMain.handle('provider:login', (_e, provider: Provider, projectId: string, cwd: string): string => {
    if (!isProvider(provider)) throw new Error(`bad provider: ${provider}`)
    const id = `login-${provider}-${newSessionId()}`
    const { cmd, args } = loginArgv(provider)
    const containerId = containerIdFor(projectId)
    const shell = containerId ? 'docker' : cmd
    const spawnArgs = containerId ? containerExecArgv(containerId, cmd, args) : args
    mgr.spawn(
      { id, shell, args: spawnArgs, cwd, env: {} },
      (data) => win.webContents.send('pty:data', { id, data }),
      ({ reason }) => win.webContents.send('session:exit', { id, reason })
    )
    return id
  })

  // F9: install a provider CLI inside the project's container (with renderer confirm).
  ipcMain.handle('provider:install', async (_e, provider: Provider, projectId: string) => {
    if (!isProvider(provider)) throw new Error(`bad provider: ${provider}`)
    const containerId = containerIdFor(projectId)
    if (!containerId) throw new Error('no running container for this project')
    await installInContainer(provider, containerId)
    return probeHealth(provider, { containerId })
  })

  // sessions persistence + global board (NN4) + resume + history (D16)
  ipcMain.handle('sessions:all', () => store?.allSessions() ?? [])
  ipcMain.handle('sessions:byProject', (_e, projectId: string) => store?.getSessions(projectId) ?? [])
  ipcMain.handle('history:sync', (_e, repoDir: string, timestamp: string) => syncHistory(repoDir, timestamp))

  // terminal pty
  ipcMain.handle('pty:spawn', (_e, o: SpawnOpts) => {
    mgr.spawn(o, (data) => win.webContents.send('pty:data', { id: o.id, data }))
    return o.id
  })
  ipcMain.on('pty:write', (_e, id: string, data: string) => mgr.write(id, data))
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => mgr.resize(id, cols, rows))
  ipcMain.on('pty:kill', (_e, id: string) => mgr.kill(id))

  // launch a real provider session (interactive CLI, subscription-safe per NN0).
  // Containerized projects run the CLI INSIDE the devcontainer with auto-approve
  // (NN2 + D26); host projects run on the host and prompt for approval.
  ipcMain.handle('session:launch', async (_e, req: LaunchRequest): Promise<Session> => {
    if (!isProvider(req.provider)) throw new Error(`bad provider: ${req.provider}`)
    const id = newSessionId()

    // Build the provider invocation. autoApprove == running in a container.
    const { cmd, args } = launchArgv({ provider: req.provider, model: req.model, autoApprove: req.useContainer })

    let shell = cmd
    let spawnArgs = args
    let cwd = req.cwd

    if (req.useContainer) {
      if (!(await hasDevcontainerCli())) {
        throw new Error('devcontainer CLI not found. Install it: npm i -g @devcontainers/cli')
      }
      win.webContents.send('session:status', { id, message: 'starting container…' })
      const containerId = await ensureContainer(req.projectId, req.cwd, req.importConfig)
      // run inside the container; docker exec carries the provider argv
      shell = 'docker'
      spawnArgs = containerExecArgv(containerId, cmd, args)
      cwd = req.cwd // docker process runs on host; -w handled by image default
    }

    const now = Date.now()
    const session: Session = {
      id,
      projectId: req.projectId,
      provider: req.provider,
      model: req.model,
      objective: req.objective || `${req.provider} session`,
      status: 'running',
      createdAt: now,
      updatedAt: now
    }
    store?.saveSession(session)

    mgr.spawn(
      { id, shell, args: spawnArgs, cwd, env: {} },
      (data) => {
        win.webContents.send('pty:data', { id, data })
        store?.appendTranscript(id, data, now)
      },
      ({ reason }) => {
        // History is always retained (item 7). Clean close -> archived;
        // crash -> stays reconnectable and the UI flags 'needs reconnect' (F4).
        store?.archiveSession(id)
        win.webContents.send('session:exit', { id, reason })
      }
    )

    return session
  })

  // resume an archived session's conversation (interactive, subscription-safe)
  ipcMain.handle('session:resume', (_e, s: Session, cwd: string): Session => {
    if (!isProvider(s.provider)) throw new Error(`bad provider: ${s.provider}`)
    const { cmd, args } = resumeArgv(s.provider)
    mgr.spawn(
      { id: s.id, shell: cmd, args, cwd, env: {} },
      (data) => {
        win.webContents.send('pty:data', { id: s.id, data })
        store?.appendTranscript(s.id, data, Date.now())
      },
      ({ reason }) => {
        store?.archiveSession(s.id)
        win.webContents.send('session:exit', { id: s.id, reason })
      }
    )
    const resumed: Session = { ...s, status: 'running', updatedAt: Date.now() }
    store?.saveSession(resumed)
    return resumed
  })
}
