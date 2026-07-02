import { app, ipcMain, dialog, shell, type BrowserWindow } from 'electron'
import { existsSync, readFileSync, writeFileSync, statSync, appendFileSync, appendFile } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { PtyManager } from './ptyManager'
import { launchArgv } from './providers'
import { allModels } from './models'
import { addProject, addProjectFromUrl, openLocalProject } from './projects'
import { listRepos, syncHistory, cloneRepo, cloneUrl, pullRepo } from './github'
import { libraryDir, scanLibrary, readLibraryItem, libraryIsClone } from './library'
import { upDevcontainer, containerExecArgv, hasDevcontainerCli, claudeConfigMount, codexConfigMount, geminiConfigMount, libraryConfigMount, findRunningContainer, findContainerPresence, startContainerById, resolveContainerUser } from './devcontainer'
import { probeHealth, loginArgv, installInContainer } from './providerHealth'
import { PortForwarder, ContainerPortWatcher, loopbackPort } from './portForwarder'
import { historyFile, buildPrimer } from './history'
import { Store } from './store'
import { confinedPath } from './confine'
import { validateLaunchRequest, validateResumeSession, validateTaskTransition } from './validate'
import { writeRawLog } from './projectLog'
import { isProvider, type Provider, type Session, type TaskKind, type TaskSubkind } from '@shared/types'

export interface FileNode {
  name: string
  dir: boolean
  depth: number
}

/** Result of a directory listing (B11): the (capped) children plus whether the
 *  listing was truncated by the per-directory cap, so the UI can offer "load
 *  more" instead of silently hiding files. */
export interface DirListing {
  nodes: FileNode[]
  truncated: boolean
}

/** Directories skipped by default in the explorer (B11): large vendored / build
 *  output trees that would make an unbounded synchronous read stall main. The
 *  explorer can override with { includeHeavy: true }. */
export const HEAVY_DIRS = new Set(['node_modules', '.venv', 'venv', 'dist', 'build', '.git', '__pycache__', '.next', 'target'])

/** Max entries returned per directory before truncation (B11). */
export const DIR_CAP = 1000

export interface ReadDirOpts {
  includeHeavy?: boolean
  cap?: number
}

/** Whether a URL is safe to hand to the OS default handler (S-URL / B-Finding 14).
 *  Terminal output is untrusted, so this is strict: parse with `new URL()`, allow
 *  ONLY http(s)/mailto schemes, and reject embedded credentials (`user:pass@host`,
 *  used to spoof) and any control characters (CR/LF/NUL/tab — header/URL
 *  smuggling). file:/custom schemes could trigger unintended local handlers. */
export function isSafeExternalUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length === 0) return false
  if (/[\x00-\x1f\x7f]/.test(url)) return false // control chars
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return false
  if (parsed.username || parsed.password) return false // embedded credentials
  return true
}

/** The single choke point for opening a URL in the OS default browser (S-URL):
 *  used by the shell:openExternal IPC, the window-open handler, and the
 *  navigation guard. Returns whether the URL was accepted and handed off. */
export function safeOpenExternal(url: string): boolean {
  if (!isSafeExternalUrl(url)) {
    console.warn('[safeOpenExternal] refused unsafe url:', url)
    return false
  }
  void shell.openExternal(url)
  return true
}

/** Immediate children of a directory (dirs first, alpha), for the explorer.
 *  B11: async (never blocks main), skips heavy vendor/build dirs by default, and
 *  caps the number of entries — reporting `truncated` so the UI can offer "load
 *  more" rather than reading an unbounded directory. Children load lazily as
 *  folders are expanded. */
export async function readDir(dir: string, opts: ReadDirOpts = {}): Promise<DirListing> {
  const cap = opts.cap ?? DIR_CAP
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const visible = entries
      .filter((e) => e.name !== '.git')
      .filter((e) => opts.includeHeavy || !(e.isDirectory() && HEAVY_DIRS.has(e.name)))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    const truncated = visible.length > cap
    const nodes = visible.slice(0, cap).map((e) => ({ name: e.name, dir: e.isDirectory(), depth: 0 }))
    return { nodes, truncated }
  } catch {
    return { nodes: [], truncated: false }
  }
}

/** Top level of the project tree (depth 0 only; subdirs fetched on expand). */
export async function readTree(root: string, opts: ReadDirOpts = {}): Promise<DirListing> {
  return readDir(root, opts)
}

// confinedPath (B1/B2 symlink-hardened) now lives in ./confine so the library
// reader (L1) shares the exact same check without depending on this module.
// Re-exported because existing callers/tests import it from ipc.
export { confinedPath }

/** B1 (Critical): resolve a renderer file request to a confined absolute path,
 *  where the renderer names the project by `projectId` — NOT by a raw filesystem
 *  root. Main owns the projectId→root mapping (`getRoot`, Store-backed in prod),
 *  so the renderer can no longer pass root='/' and read arbitrary host files.
 *  Returns null for an unknown project or a path that escapes its root. */
export function resolveProjectFile(
  getRoot: (projectId: string) => string | undefined,
  projectId: string,
  relPath: string
): string | null {
  const root = getRoot(projectId)
  if (!root) return null // unknown/unregistered project — refuse
  return confinedPath(root, relPath)
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
  /** M-LOG-a (§4.1): the task label chosen at launch. Required for agent
   *  sessions; `taskSubkind` is required when `taskKind` is 'product'. */
  taskKind?: TaskKind
  taskSubkind?: TaskSubkind
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
  // Mount the IDE library (read-only) so in-container sessions can use its
  // skills/workflows. Only when it has content (a cloned repo), to avoid binding
  // an empty placeholder dir. (D14)
  const lib = libraryDir()
  if (existsSync(join(lib, 'skills')) || existsSync(join(lib, 'workflows')) || existsSync(join(lib, 'prompts'))) {
    mounts.push(libraryConfigMount(lib))
  }
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
// and any dev server). B5: ONE watcher per CONTAINER, refcounted by the sessions
// using it — a session ending must not tear down forwards another session in the
// same container still needs. The watcher (and its forwards) stop only when the
// last session in that container stops.
const watchers = new Map<string, { watcher: ContainerPortWatcher; sessions: Set<string> }>()
function startPortWatch(sessionId: string, containerId: string, win: BrowserWindow): void {
  const existing = watchers.get(containerId)
  if (existing) {
    existing.sessions.add(sessionId) // share the one watcher for this container
    return
  }
  const watcher = new ContainerPortWatcher(containerId, forwarder, {
    onForward: (port) => win.webContents.send('session:status', { id: sessionId, message: `forwarding container port ${port} → localhost:${port}` })
  })
  watchers.set(containerId, { watcher, sessions: new Set([sessionId]) })
  watcher.start()
}
function stopPortWatch(sessionId: string): void {
  for (const [containerId, entry] of watchers) {
    if (!entry.sessions.delete(sessionId)) continue
    if (entry.sessions.size === 0) { // last session in this container — tear down
      watchers.delete(containerId)
      void entry.watcher.stop()
    }
    return
  }
}

/** Persist a chunk of session output: to the SQLite transcript (fast reads /
 *  in-app replay) AND to the per-session history file (human-readable, git-
 *  committable). The file is the IDE-owned history — the source of truth for
 *  reconnect/model-swap primers, independent of any provider CLI. */
function recordOutput(store: Store | undefined, sessionId: string, data: string): void {
  // DB write is batched/debounced inside the Store (B6). The human-readable file
  // mirror is appended asynchronously so a burst of PTY output never blocks the
  // main thread on synchronous disk I/O (B6). Best-effort — the DB is the source
  // of truth for primers; the file is a convenience/committable mirror.
  store?.appendTranscript(sessionId, data, Date.now())
  appendFile(historyFile(sessionId), data, () => { /* best-effort mirror */ })
}

/** After a fresh engine starts for an existing session (reconnect or model swap),
 *  seed it with the session's prior history so it continues with context. The
 *  IDE owns this history (cleaned terminal text) — independent of any provider
 *  CLI's own resume. B12: the primer is typed in once the terminal settles (not on
 *  a blind fixed delay) and is tied to the session's current pty generation, so it
 *  never lands in a killed/replaced session or interleaves the initial render. A
 *  trailing newline submits it. No-op when there's no prior history. */
function seedPrimer(mgr: PtyManager, store: Store | undefined, sessionId: string): void {
  const transcript = store?.getTranscript(sessionId) ?? ''
  const primer = buildPrimer(transcript)
  if (!primer) return
  mgr.primeWhenReady(sessionId, primer + '\n')
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
          // Ad-hoc forward for an opened URL; owned by the container so it isn't
          // torn down when one session ends (B5). Bounded so a slow/hung forward
          // can't block opening the browser (Codex P4).
          await Promise.race([
            forwarder.ensure(containerId, port, `manual:${containerId}`),
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

  // B1: the renderer names the project by id; main resolves the confined root
  // from its own Store (never a renderer-supplied filesystem path).
  const projectRoot = (id: string): string | undefined => store?.getProject(id)?.localPath

  // Top level of a project's file tree. Confined by projectId: an unknown project
  // (or one whose root can't be resolved) yields an empty tree, never a host path.
  // B11: async, returns { nodes, truncated }.
  ipcMain.handle('fs:tree', async (_e, projectId: string): Promise<DirListing> => {
    const root = projectRoot(projectId)
    return root ? readTree(root) : { nodes: [], truncated: false }
  })

  // Library (GitHub-backed Prompts/Skills/Workflows) — D14. The library is a
  // clone of the user's library repo under ~/AgentIDE/library; we scan it into
  // the three categories and read individual items (confined to the library).
  ipcMain.handle('library:list', () => scanLibrary(libraryDir()))
  // B9: validate the renderer input at the boundary; a non-string relPath is
  // refused, not passed into path resolution.
  ipcMain.handle('library:read', (_e, relPath: unknown) =>
    typeof relPath === 'string' ? readLibraryItem(relPath) : { error: 'invalid path' }
  )
  ipcMain.handle('library:status', () => {
    const dir = libraryDir()
    const lib = scanLibrary(dir)
    return {
      dir,
      isClone: libraryIsClone(dir),
      counts: { prompts: lib.prompts.length, skills: lib.skills.length, workflows: lib.workflows.length }
    }
  })
  // Sync: pull if already a clone; otherwise clone the given repo (owner/name via
  // gh, or any git URL) into the (empty) library dir. `repo` is optional when a
  // clone already exists. Returns the refreshed contents (or an error).
  ipcMain.handle('library:sync', async (_e, repo?: string): Promise<{ ok?: true; error?: string }> => {
    const dir = libraryDir()
    try {
      if (libraryIsClone(dir)) {
        await pullRepo(dir)
      } else if (repo) {
        const isUrl = /^(https?:|git@|ssh:)/.test(repo)
        if (isUrl) await cloneUrl(repo, dir)
        else await cloneRepo(repo, dir)
      } else {
        return { error: 'no library repo configured yet' }
      }
      return { ok: true }
    } catch (err) {
      return { error: (err as Error).message }
    }
  })

  // Lazy directory expansion for the explorer: immediate children of `path`,
  // which must resolve inside the project's root (confined; no host escape).
  ipcMain.handle('fs:dir', async (_e, projectId: string, path: string): Promise<DirListing> => {
    const dir = resolveProjectFile(projectRoot, projectId, path)
    return dir ? readDir(dir) : { nodes: [], truncated: false }
  })

  // Read a file's text for the editor tab. Confined to the project tree; refuses
  // oversized (>2 MB) or binary-looking files (NUL byte) so the textarea isn't
  // flooded with garbage. Returns { content } or { error }.
  ipcMain.handle('file:read', (_e, projectId: string, path: string): { content?: string; error?: string } => {
    const file = resolveProjectFile(projectRoot, projectId, path)
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
  ipcMain.handle('file:write', (_e, projectId: string, path: string, content: string): { ok?: true; error?: string } => {
    const file = resolveProjectFile(projectRoot, projectId, path)
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

  // M-LOG-a (§4.1): advance a task's lifecycle status (open→finished→deployed→
  // ticketed), forward-only. Product chats marked 'finished' also export their raw
  // log entry (§4.3); analysis chats just advance the status (no log). Returns the
  // written log path (product+finished) or {ok}, or {error} on a bad transition.
  ipcMain.handle('task:setStatus', async (_e, id: unknown, to: unknown): Promise<{ ok?: true; logPath?: string; error?: string }> => {
    if (typeof id !== 'string' || !store) return { error: 'invalid request' }
    const session = store.getSession(id)
    if (!session) return { error: 'unknown session' }
    let target: string
    try {
      target = validateTaskTransition(session.taskStatus, to)
    } catch (err) {
      return { error: (err as Error).message }
    }
    store.setTaskStatus(id, target)
    // §4.3: only a PRODUCT chat entering 'finished' writes a raw log entry.
    if (target === 'finished' && session.taskKind === 'product') {
      const logPath = writeRawLog(store, { ...session, taskStatus: target })
      return logPath ? { ok: true, logPath } : { ok: true }
    }
    return { ok: true }
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
  ipcMain.handle('provider:login', async (_e, provider: Provider, projectId: string, cwd: string): Promise<string> => {
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
  // B8: the history repo dir is main-owned (historyDir()); the renderer supplies
  // only the timestamp and never a filesystem path. Returns per-step status.
  ipcMain.handle('history:sync', (_e, timestamp: string) => syncHistory(String(timestamp ?? '')))

  // terminal pty write/resize/kill only. S-NOSPAWN (keep-list #1): there is NO
  // pty:spawn — the renderer must not be able to start an arbitrary shell with
  // arbitrary argv/cwd/env, bypassing session:launch/terminal:open, the
  // FORBIDDEN_FLAGS guard, and payload validation. All ptys are started in main.
  ipcMain.on('pty:write', (_e, id: string, data: string) => mgr.write(id, data))
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => mgr.resize(id, cols, rows))
  ipcMain.on('pty:kill', (_e, id: string) => mgr.kill(id))

  // launch a real provider session (interactive CLI, subscription-safe per NN0).
  // Containerized projects run the CLI INSIDE the devcontainer with auto-approve
  // (NN2 + D26); host projects run on the host and prompt for approval.
  ipcMain.handle('session:launch', async (_e, raw: unknown): Promise<Session> => {
    // B9: validate the renderer payload in main (types don't cross IPC). Enforces
    // provider/model membership, project ownership, field types + length caps.
    const req: LaunchRequest = validateLaunchRequest(raw, (id) => !!store?.getProject(id))
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
      updatedAt: now,
      // M-LOG-a: the task label validated at launch; a new task starts 'open'.
      taskKind: req.taskKind ?? null,
      taskSubkind: req.taskSubkind ?? null,
      taskStatus: req.taskKind ? 'open' : null
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
  ipcMain.handle('session:resume', async (_e, rawSession: unknown, rawCwd: unknown, rawUseContainer: unknown, rawOverride?: unknown): Promise<Session> => {
    // B9: validate the renderer payload in main. The session's provider/model/
    // status are membership-checked; an optional model override is validated as a
    // fresh launch request (provider + model membership) reusing the same guards.
    const s: Session = validateResumeSession(rawSession)
    const cwd = typeof rawCwd === 'string' ? rawCwd : ''
    const useContainer = rawUseContainer === true
    let modelOverride: { provider: Provider; model: string } | undefined
    if (rawOverride !== undefined) {
      const ov = validateResumeSession({ ...s, provider: (rawOverride as { provider?: unknown }).provider, model: (rawOverride as { model?: unknown }).model })
      modelOverride = { provider: ov.provider, model: ov.model }
    }
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
    for (const { watcher } of watchers.values()) void watcher.stop()
    watchers.clear()
    void forwarder.disposeAll()
    store?.flush() // B6: persist any buffered transcript chunks before exit
  })
}
