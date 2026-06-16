import { app, ipcMain, dialog, shell, type BrowserWindow } from 'electron'
import { readdirSync, existsSync, readFileSync, writeFileSync, statSync, appendFileSync } from 'node:fs'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { PtyManager, type SpawnOpts } from './ptyManager'
import { launchArgv } from './providers'
import { allModels } from './models'
import { addProject, addProjectFromUrl, openLocalProject } from './projects'
import { listRepos, syncHistory } from './github'
import { upDevcontainer, containerExecArgv, hasDevcontainerCli, claudeConfigMount, codexConfigMount, geminiConfigMount, findRunningContainer, findContainerPresence, startContainerById, resolveContainerUser } from './devcontainer'
import { probeHealth, loginArgv, installInContainer } from './providerHealth'
import { PortForwarder, ContainerPortWatcher, loopbackPort } from './portForwarder'
import { historyFile, buildPrimer } from './history'
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
  // Make the host's provider logins visible inside the container (read-only), so
  // containerized sessions are pre-authenticated and never need an in-container
  // OAuth loopback (the callback can't reach a listener trapped in the container's
  // network namespace). Mounted into the remoteUser's home (sessions exec as that
  // user, not root). ~/.claude stays opt-in via importConfig; ~/.codex and
  // ~/.gemini mount whenever present. Only mount dirs that exist so the build
  // doesn't fail on a bind to a missing source.
  const home = homedir()
  const mounts: string[] = []
  if (existsSync(join(home, '.codex'))) mounts.push(codexConfigMount(home))
  if (existsSync(join(home, '.gemini'))) mounts.push(geminiConfigMount(home))
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

// Host-side port forwarders (one per container:port), for opening in-container
// localhost services in the host browser. Lives for the app's lifetime.
const forwarder = new PortForwarder()

// VS Code-style auto port forwarding: while a containerized session runs, watch
// the container for newly-listening localhost ports and forward each to the same
// host port (so the host browser reaches in-container OAuth callbacks like :1455
// and any dev server). One watcher per containerized session id.
const watchers = new Map<string, ContainerPortWatcher>()
function startPortWatch(sessionId: string, containerId: string, win: BrowserWindow): void {
  if (watchers.has(sessionId)) return
  const w = new ContainerPortWatcher(containerId, forwarder, {
    onForward: (port) => win.webContents.send('session:status', { id: sessionId, message: `forwarding container port ${port} → localhost:${port}` })
  })
  watchers.set(sessionId, w)
  w.start()
}
function stopPortWatch(sessionId: string): void {
  const w = watchers.get(sessionId)
  if (!w) return
  watchers.delete(sessionId)
  void w.stop()
}

/** Persist a chunk of session output: to the SQLite transcript (fast reads /
 *  in-app replay) AND to the per-session history file (human-readable, git-
 *  committable). The file is the IDE-owned history — the source of truth for
 *  reconnect/model-swap primers, independent of any provider CLI. */
function recordOutput(store: Store | undefined, sessionId: string, data: string): void {
  store?.appendTranscript(sessionId, data, Date.now())
  try { appendFileSync(historyFile(sessionId), data) } catch { /* best-effort mirror */ }
}

/** After a fresh engine starts for an existing session (reconnect or model swap),
 *  seed it with the session's prior history so it continues with context. The
 *  IDE owns this history (cleaned terminal text) — independent of any provider
 *  CLI's own resume. Typed in after a short delay so the TUI is ready for input;
 *  a trailing newline submits it. No-op when there's no prior history. */
function seedPrimer(mgr: PtyManager, store: Store | undefined, sessionId: string): void {
  const transcript = store?.getTranscript(sessionId) ?? ''
  const primer = buildPrimer(transcript)
  if (!primer) return
  setTimeout(() => { try { mgr.write(sessionId, primer + '\n') } catch { /* pty gone */ } }, 1200)
}

/** Resolve the running container a session belongs to, if any. Looks the session
 *  up in the store to get its project workspace, then queries Docker. Returns
 *  undefined for host sessions or when no container is running. */
async function containerForSession(store: Store | undefined, sessionId: string): Promise<string | undefined> {
  if (!store) return undefined
  const session = store.allSessions().find((s) => s.id === sessionId)
  if (!session) return undefined
  const project = store.listProjects().find((p) => p.id === session.projectId)
  if (!project) return undefined
  return resolveContainerId(project.id, project.localPath)
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
  //
  // Container fix: a `localhost:<port>` URL printed by an agent INSIDE a container
  // points at the container's loopback, which the host browser can't reach. If
  // the originating session runs in a container, forward that port out to the
  // host first (VS Code-style), then open the same localhost URL — this is what
  // makes the OpenAI OAuth callback (:1455) and any in-container dev server work.
  ipcMain.handle('shell:openExternal', async (_e, url: string, sessionId?: string): Promise<boolean> => {
    if (!isSafeExternalUrl(url)) {
      console.warn('[openExternal] refused unsafe url:', url)
      return false
    }
    // Test observability seam: when AGENT_IDE_OPEN_LOG is set, ALSO record the URL.
    // It must never REPLACE the real open (that would silently lie that links work),
    // so this records and falls through to shell.openExternal below.
    if (process.env.AGENT_IDE_OPEN_LOG) {
      try { appendFileSync(process.env.AGENT_IDE_OPEN_LOG, url + '\n') } catch { /* best-effort */ }
    }
    try {
      // If a containerized session printed a localhost URL, forward that port out
      // to the host first so the browser can reach it. Bounded so a slow/hung
      // forward can't block opening the browser (Codex P4).
      const port = loopbackPort(url)
      if (port && sessionId) {
        const containerId = await containerForSession(store, sessionId)
        if (containerId) {
          await Promise.race([
            forwarder.ensure(containerId, port),
            new Promise((r) => setTimeout(r, 2500))
          ])
        }
      }
      await shell.openExternal(url)
      return true
    } catch (err) {
      // Don't swallow silently — a discarded error here is exactly why "links
      // don't open" was undiagnosable. Surface it (and the context) to the log.
      console.error('[openExternal] failed for', url, 'session', sessionId, '-', (err as Error).message)
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
      // up if needed so the terminal really runs inside it. Exec as the non-root
      // remoteUser so the shell matches what agent sessions use.
      const containerId = await ensureContainer(req.projectId, req.cwd)
      const user = await resolveContainerUser(containerId)
      shell = 'docker'
      args = containerExecArgv(containerId, 'bash', [], { user: user ?? undefined })
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
      (data) => { win.webContents.send('pty:data', { id, data }); recordOutput(store, id, data) },
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
  ipcMain.handle('provider:login', async (_e, provider: Provider, projectId: string, _cwd: string): Promise<string> => {
    if (!isProvider(provider)) throw new Error(`bad provider: ${provider}`)
    const id = `login-${provider}-${newSessionId()}`
    const { cmd, args } = loginArgv(provider)
    // ALL provider logins run on the HOST, never in the container. OAuth logins
    // start a localhost loopback listener and the auth provider redirects the
    // host browser back to it; that callback is a browser-side redirect, so it
    // never passes through our openExternal port-forwarding. If login ran in the
    // container the listener would be trapped in its network namespace and the
    // callback would never land (the "browser response doesn't come through"
    // bug). Logging in on the host writes ~/.codex / ~/.claude / ~/.gemini, which
    // are bind-mounted (read-only) into the container so containerized sessions
    // are already authenticated. cwd is irrelevant for a host login.
    const shell = cmd
    const spawnArgs = args
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
    let watchContainer: string | undefined

    if (req.useContainer) {
      if (!(await hasDevcontainerCli())) {
        throw new Error('devcontainer CLI not found. Install it: npm i -g @devcontainers/cli')
      }
      win.webContents.send('session:status', { id, message: 'starting container…' })
      const containerId = await ensureContainer(req.projectId, req.cwd, req.importConfig)
      // run inside the container as its non-root remoteUser; docker exec carries
      // the provider argv. Root would break auto-approve (claude
      // --dangerously-skip-permissions refuses to run as root).
      const user = await resolveContainerUser(containerId)
      shell = 'docker'
      spawnArgs = containerExecArgv(containerId, cmd, args, { user: user ?? undefined })
      cwd = req.cwd // docker process runs on host; -w handled by image default
      watchContainer = containerId
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
          recordOutput(store, id, data)
        },
        ({ reason }) => {
          // History always retained (item 7). Clean close -> archived; crash ->
          // NOT archived (status idle) so it stays reconnectable (F4 / Codex P1).
          if (reason === 'closed') store?.archiveSession(id)
          else store?.setSessionStatus(id, 'idle')
          stopPortWatch(id)
          win.webContents.send('session:exit', { id, reason })
        }
      )
    } catch (err) {
      throw new Error(`failed to start ${req.provider} session: ${(err as Error).message}`)
    }
    store?.saveSession(session)

    // Auto-forward any localhost port the in-container agent opens (OAuth :1455,
    // dev servers, …) so the host browser can reach it — VS Code-style.
    if (watchContainer) startPortWatch(id, watchContainer, win)

    return session
  })

  // Reconnect a session. The IDE owns the conversation (not the provider CLI), so
  // we DON'T use provider "resume last/continue" flags — those grab whichever
  // conversation the CLI saw last, which made independent sessions of the same
  // provider bleed into one another. Instead we launch the engine FRESH and seed
  // it with this session's own stored history (cleaned). Runs in the SAME context
  // as the original (container vs host, Codex P1). Optional model override lets
  // "change model" reuse this exact path to move the conversation to another engine.
  ipcMain.handle('session:resume', async (_e, s: Session, cwd: string, useContainer: boolean, modelOverride?: { provider: Provider; model: string }): Promise<Session> => {
    const provider = modelOverride?.provider ?? s.provider
    const model = modelOverride?.model ?? s.model
    if (!isProvider(provider)) throw new Error(`bad provider: ${provider}`)
    // Fresh interactive launch (NOT resumeArgv). autoApprove == in a container.
    const { cmd, args } = launchArgv({ provider, model, autoApprove: useContainer })
    let shell = cmd
    let spawnArgs = args
    let watchContainer: string | undefined
    if (useContainer) {
      const containerId = await resolveContainerId(s.projectId, cwd)
      if (!containerId) throw new Error('cannot reconnect: the project container is not running')
      const user = await resolveContainerUser(containerId)
      shell = 'docker'
      spawnArgs = containerExecArgv(containerId, cmd, args, { user: user ?? undefined })
      watchContainer = containerId
    }
    mgr.spawn(
      { id: s.id, shell, args: spawnArgs, cwd, env: {} },
      (data) => {
        win.webContents.send('pty:data', { id: s.id, data })
        recordOutput(store, s.id, data)
      },
      ({ reason }) => {
        stopPortWatch(s.id)
        if (reason === 'closed') store?.archiveSession(s.id)
        else store?.setSessionStatus(s.id, 'idle')
        win.webContents.send('session:exit', { id: s.id, reason })
      }
    )
    // Seed the fresh engine with this session's prior history (context continuity).
    seedPrimer(mgr, store, s.id)
    if (watchContainer) startPortWatch(s.id, watchContainer, win)
    const resumed: Session = { ...s, provider, model, status: 'running', updatedAt: Date.now() }
    store?.saveSession(resumed)
    return resumed
  })

  // Tear down port watchers + host-side relays on shutdown (container relays die
  // with the container). Avoids leaking python relay processes across app restarts.
  app.on('before-quit', () => {
    for (const w of watchers.values()) void w.stop()
    watchers.clear()
    forwarder.disposeAll()
  })
}
