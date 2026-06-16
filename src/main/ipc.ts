import { ipcMain, dialog, shell, type BrowserWindow } from 'electron'
import { readdirSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { PtyManager, type SpawnOpts } from './ptyManager'
import { launchArgv, resumeArgv } from './providers'
import { allModels } from './models'
import { addProject, addProjectFromUrl, openLocalProject } from './projects'
import { listRepos, syncHistory } from './github'
import { upDevcontainer, containerExecArgv, hasDevcontainerCli, claudeConfigMount, codexConfigMount, findRunningContainer, findContainerPresence, startContainerById } from './devcontainer'
import { probeHealth, loginArgv, installInContainer } from './providerHealth'
import { Store } from './store'
import { isProvider, type Provider, type Session } from '@shared/types'

export interface FileNode {
  name: string
  dir: boolean
  depth: number
}

/** Whether a URL is safe to hand to the OS default handler. Only http(s) and
 *  mailto are allowed — terminal output is untrusted and file:/custom schemes
 *  could trigger unintended local handlers. */
export function isSafeExternalUrl(url: unknown): url is string {
  return typeof url === 'string' && /^(https?|mailto):/i.test(url)
}

/** Immediate children of a directory (dirs first, alpha), for the explorer.
 *  Children load lazily as folders are expanded — no fixed depth/count cap. */
export function readDir(dir: string): FileNode[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.name !== '.git')
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .map((e) => ({ name: e.name, dir: e.isDirectory(), depth: 0 }))
  } catch {
    return []
  }
}

/** Top level of the project tree (depth 0 only; subdirs fetched on expand). */
export function readTree(root: string): FileNode[] {
  return readDir(root)
}

/** Resolve `target` and confirm it stays inside `root` (no `..`/symlink escape).
 *  File reads/writes from the renderer are confined to the open project's tree —
 *  the renderer must never read/write arbitrary host paths. Returns the resolved
 *  absolute path, or null if it would escape. */
export function confinedPath(root: string, target: string): string | null {
  const r = resolve(root)
  const t = resolve(root, target)
  const rel = relative(r, t)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  return t
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
// The map is a cache; Docker is the source of truth (survives app restarts).
const containerByProject = new Map<string, string>()
async function ensureContainer(projectId: string, workspace: string, importConfig = false): Promise<string> {
  // Docker is the source of truth (Codex P2 — no stale cache fast-path):
  // running -> reuse; stopped -> start it (don't rebuild); none -> build.
  const presence = await findContainerPresence(workspace)
  if (presence.state === 'running') {
    containerByProject.set(projectId, presence.id)
    return presence.id
  }
  if (presence.state === 'stopped') {
    await startContainerById(presence.id)
    containerByProject.set(projectId, presence.id)
    return presence.id
  }
  // Always make the host's Codex login visible inside the container (read-only),
  // so a containerized Codex session is pre-authenticated and never needs the
  // in-container OAuth loopback (localhost:1455, which the host browser can't
  // reach). ~/.claude stays opt-in via importConfig. Only mount dirs that exist
  // so the build doesn't fail on a bind to a missing source.
  const home = homedir()
  const mounts: string[] = []
  if (existsSync(join(home, '.codex'))) mounts.push(codexConfigMount(home))
  if (importConfig && existsSync(join(home, '.claude'))) mounts.push(claudeConfigMount(home))
  const { containerId } = await upDevcontainer(workspace, mounts)
  containerByProject.set(projectId, containerId)
  return containerId
}

/** Authoritative running-container id for a project. Docker is the source of
 *  truth (Codex P2 — never trust a cached id that may be stopped/removed); the
 *  cache is refreshed from the query result. */
async function resolveContainerId(projectId: string, workspace: string): Promise<string | undefined> {
  const running = await findRunningContainer(workspace)
  if (running) containerByProject.set(projectId, running)
  else containerByProject.delete(projectId)
  return running ?? undefined
}

/** Registers all main-process IPC handlers. Thin router — logic lives in managers.
 *  `store` may be undefined if persistence failed to initialize; handlers then
 *  no-op writes and return empty reads so the UI still works. */
export function registerIpc(mgr: PtyManager, win: BrowserWindow, store?: Store): void {
  ipcMain.handle('ping', () => 'pong')

  // Open a URL in the host's default browser. Runs host-side, so it works even
  // when the originating session lives inside a container (which has no browser
  // or host display). URLs can come from untrusted CLI output — isSafeExternalUrl
  // gates the scheme so only http(s)/mailto reach the OS (never file: or custom).
  ipcMain.handle('shell:openExternal', async (_e, url: string): Promise<boolean> => {
    if (!isSafeExternalUrl(url)) return false
    // Await + report the real outcome so the renderer can fall back (e.g. copy
    // the URL) instead of silently failing when the OS handler errors.
    try {
      await shell.openExternal(url)
      return true
    } catch {
      return false
    }
  })

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

  // Lazy directory expansion for the explorer: immediate children of `path`,
  // which must resolve inside the project `root` (confined; no host escape).
  ipcMain.handle('fs:dir', (_e, root: string, path: string): FileNode[] => {
    const dir = confinedPath(root, path)
    return dir ? readDir(dir) : []
  })

  // Read a file's text for the editor tab. Confined to the project tree; refuses
  // oversized (>2 MB) or binary-looking files (NUL byte) so the textarea isn't
  // flooded with garbage. Returns { content } or { error }.
  ipcMain.handle('file:read', (_e, root: string, path: string): { content?: string; error?: string } => {
    const file = confinedPath(root, path)
    if (!file) return { error: 'path outside project' }
    try {
      if (statSync(file).size > 2 * 1024 * 1024) return { error: 'file too large to open (>2 MB)' }
      const buf = readFileSync(file)
      if (buf.includes(0)) return { error: 'binary file' }
      return { content: buf.toString('utf8') }
    } catch (err) {
      return { error: (err as Error).message }
    }
  })

  // Save edited text back to a file in the project tree (confined). Returns
  // { ok } or { error } so the renderer can surface save failures.
  ipcMain.handle('file:write', (_e, root: string, path: string, content: string): { ok?: true; error?: string } => {
    const file = confinedPath(root, path)
    if (!file) return { error: 'path outside project' }
    try {
      writeFileSync(file, content, 'utf8')
      return { ok: true }
    } catch (err) {
      return { error: (err as Error).message }
    }
  })

  // rename a session (F3/F6)
  ipcMain.handle('session:rename', (_e, id: string, name: string) => {
    store?.renameSession(id, name)
  })

  // close + archive a session: kill its pty and persist archived status (F6).
  ipcMain.handle('session:archive', (_e, id: string) => {
    mgr.kill(id)
    store?.archiveSession(id)
  })

  // F13: open a plain shell session (no agent) in the project's context.
  ipcMain.handle('terminal:open', async (_e, req: { projectId: string; cwd: string; name: string; useContainer: boolean }): Promise<Session> => {
    const id = `term-${newSessionId()}`
    let shell = 'bash'
    let args: string[] = []
    let cwd = req.cwd
    if (req.useContainer) {
      // Don't silently downgrade to a host shell (Codex P2): bring the container
      // up if needed so the terminal really runs inside it.
      const containerId = await ensureContainer(req.projectId, req.cwd)
      shell = 'docker'
      args = containerExecArgv(containerId, 'bash', [])
      cwd = req.cwd
    }
    const now = Date.now()
    const session: Session = {
      id, projectId: req.projectId, provider: 'codex', // provider unused for terminals; see isTerminal()
      model: 'shell', objective: req.name || 'terminal', status: 'running', createdAt: now, updatedAt: now
    }
    store?.saveSession(session)
    mgr.spawn(
      { id, shell, args, cwd, env: {} },
      (data) => { win.webContents.send('pty:data', { id, data }); store?.appendTranscript(id, data, Date.now()) },
      ({ reason }) => { store?.archiveSession(id); win.webContents.send('session:exit', { id, reason }) }
    )
    return session
  })

  // F14: explicitly bring up the project's devcontainer once (warm it before
  // launching sessions). Returns the container id. Reused by all its sessions.
  ipcMain.handle('container:start', async (_e, projectId: string, workspace: string, importConfig: boolean) => {
    if (!(await hasDevcontainerCli())) {
      throw new Error('devcontainer CLI not found. Install it: npm i -g @devcontainers/cli')
    }
    win.webContents.send('container:status', { projectId, state: 'starting' })
    try {
      const containerId = await ensureContainer(projectId, workspace, importConfig)
      win.webContents.send('container:status', { projectId, state: 'running' })
      return containerId
    } catch (err) {
      win.webContents.send('container:status', { projectId, state: 'error' })
      throw err
    }
  })
  // Container status for this project, by Docker state (accurate across app
  // restarts): 'running' | 'stopped' (built but exited) | 'none' (never built).
  ipcMain.handle('container:status', async (_e, _projectId: string, workspace: string) => {
    return (await findContainerPresence(workspace)).state
  })

  // F8: provider connection health, in the project's context (host or container).
  ipcMain.handle('provider:health', async (_e, provider: Provider, projectId: string, cwd: string) => {
    if (!isProvider(provider)) throw new Error(`bad provider: ${provider}`)
    const containerId = await resolveContainerId(projectId, cwd)
    return probeHealth(provider, { containerId })
  })

  // F10: run an interactive CLI login as a terminal session, in project context.
  ipcMain.handle('provider:login', async (_e, provider: Provider, projectId: string, cwd: string): Promise<string> => {
    if (!isProvider(provider)) throw new Error(`bad provider: ${provider}`)
    const id = `login-${provider}-${newSessionId()}`
    const { cmd, args } = loginArgv(provider)
    // Codex login MUST run on the host: it starts an OAuth loopback listener on
    // a fixed localhost:1455 and the host browser is redirected back to it. Run
    // inside the container and that listener is trapped in the container's
    // network namespace (no port forwarding) — the callback never lands and
    // login hangs. The resulting ~/.codex token is then bind-mounted (read-only)
    // into the container so containerized sessions are authenticated anyway.
    const containerId = provider === 'codex' ? undefined : await resolveContainerId(projectId, cwd)
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
  ipcMain.handle('provider:install', async (_e, provider: Provider, projectId: string, cwd: string) => {
    if (!isProvider(provider)) throw new Error(`bad provider: ${provider}`)
    const containerId = await resolveContainerId(projectId, cwd)
    if (!containerId) throw new Error('no running container for this project')
    await installInContainer(provider, containerId)
    return probeHealth(provider, { containerId })
  })

  // Replay a session's saved terminal output (chat history). The renderer writes
  // this into xterm on mount BEFORE subscribing to live data, so reopening or
  // reconnecting a session shows its prior transcript instead of a blank pane.
  ipcMain.handle('transcript:get', (_e, id: string): string => store?.getTranscript(id) ?? '')

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
    // Spawn FIRST; only persist once the pty actually started (Codex P2 — a
    // failed spawn must not leave a persisted "running" ghost session).
    try {
      mgr.spawn(
        { id, shell, args: spawnArgs, cwd, env: {} },
        (data) => {
          win.webContents.send('pty:data', { id, data })
          store?.appendTranscript(id, data, Date.now())
        },
        ({ reason }) => {
          // History always retained (item 7). Clean close -> archived; crash ->
          // NOT archived (status idle) so it stays reconnectable (F4 / Codex P1).
          if (reason === 'closed') store?.archiveSession(id)
          else store?.setSessionStatus(id, 'idle')
          win.webContents.send('session:exit', { id, reason })
        }
      )
    } catch (err) {
      throw new Error(`failed to start ${req.provider} session: ${(err as Error).message}`)
    }
    store?.saveSession(session)

    return session
  })

  // resume a session's conversation (interactive, subscription-safe). Runs in
  // the SAME context as the original: inside the container if useContainer
  // (Codex P1 — a crashed container session must not resume on the host).
  ipcMain.handle('session:resume', async (_e, s: Session, cwd: string, useContainer: boolean): Promise<Session> => {
    if (!isProvider(s.provider)) throw new Error(`bad provider: ${s.provider}`)
    const { cmd, args } = resumeArgv(s.provider)
    let shell = cmd
    let spawnArgs = args
    if (useContainer) {
      const containerId = await resolveContainerId(s.projectId, cwd)
      if (!containerId) throw new Error('cannot reconnect: the project container is not running')
      shell = 'docker'
      spawnArgs = containerExecArgv(containerId, cmd, args)
    }
    mgr.spawn(
      { id: s.id, shell, args: spawnArgs, cwd, env: {} },
      (data) => {
        win.webContents.send('pty:data', { id: s.id, data })
        store?.appendTranscript(s.id, data, Date.now())
      },
      ({ reason }) => {
        if (reason === 'closed') store?.archiveSession(s.id)
        else store?.setSessionStatus(s.id, 'idle')
        win.webContents.send('session:exit', { id: s.id, reason })
      }
    )
    const resumed: Session = { ...s, status: 'running', updatedAt: Date.now() }
    store?.saveSession(resumed)
    return resumed
  })
}
