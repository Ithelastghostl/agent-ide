import { app, ipcMain, dialog, shell, clipboard, BrowserWindow } from 'electron'
import {
  existsSync,
  readFileSync,
  writeFileSync,
  statSync,
  appendFileSync,
  appendFile,
  readdirSync
} from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { launchArgv, resolveEffort } from './providers'
import { allModels, defaultModel } from './models'
import { addProject, addProjectFromUrl, openLocalProject } from './projects'
import { listRepos, syncHistory, cloneRepo, cloneUrl, pullRepo } from './github'
import { libraryDir, scanLibrary, readLibraryItem, libraryIsClone, addAgent } from './library'
import { isRegisteredAgent, composeLaunchPrimer } from './agentPreset'
// Pure argv/mount builders stay here (platform-agnostic); side-effecting docker
// ops now go through runtime.container (M1).
import { containerExecArgv, libraryConfigMount, providerSeedFiles } from './devcontainer'
import { loginArgv } from './providerHealth'
import { probeAllServices, loginArgv as serviceLoginArgv } from './serviceHealth'
import { loopbackPort } from './portForwarder'
import type {
  Runtime,
  TerminalRuntime,
  ContainerRuntime,
  PortForwardService,
  PortWatchHandle
} from './runtime'
import { historyFile, buildPrimer, stripAnsi, removeHistory } from './history'
import { hostShell } from './ptyManager'
import { sessionEvents } from './sessionEvents'
import { Store } from './store'
import { confinedPath } from './confine'
import {
  validateLaunchRequest,
  validateResumeSession,
  validateTaskTransition,
  isKnownModel
} from './validate'
import { writeRawLog, writeTicketFile } from './projectLog'
import { generateTicket, type HeadlessRunner } from './ticketService'
import { notEnabledRunner } from './headlessRunner'
import { LaunchService } from './launchService'
import { registerBacklogIpc, bindLaunchBacklog } from './ipc/backlog'
import { registerQueueIpc } from './ipc/queue'
import { registerSearchIpc } from './ipc/search'
import { registerHarnessIpc } from './ipc/harness'
import { registerReviewIpc } from './ipc/review'
import { registerGitIpc } from './ipc/git'
import { registerLinearIpc } from './ipc/linear'
import { registerAttentionIpc } from './ipc/attention'
import type { IpcDeps } from './ipc/deps'
import {
  isProvider,
  SERVICES,
  type Provider,
  type Session,
  type TaskKind,
  type TaskSubkind,
  type SessionStage,
  type ServiceName,
  type Effort
} from '@shared/types'

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
export const HEAVY_DIRS = new Set([
  'node_modules',
  '.venv',
  'venv',
  'dist',
  'build',
  '.git',
  '__pycache__',
  '.next',
  'target'
])

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

/** Send an event to the current live renderer, if any. IPC state is app-scoped
 *  (macOS recreates windows on Dock activation), so pty/session callbacks must
 *  not close over one BrowserWindow — with the window closed, sessions keep
 *  running and events are simply dropped; the transcript replays on reopen. */
export function sendToRenderer(channel: string, payload: unknown): void {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  win?.webContents.send(channel, payload)
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
  /** S8: a library agent preset this session launches from. Validated in main
   *  (confinedPath(libraryDir) + membership in scanLibrary().agents); its body is
   *  primed into the session after the harness section. Persisted for the chip. */
  agentRelPath?: string | null
  /** Per-session reasoning effort picked in the model picker. AGENT_IDE_EFFORT
   *  still outranks it at spawn time (resolveEffort). */
  effort?: Effort | null
}

let seq = 0
function newSessionId(): string {
  seq += 1
  return `sess-${seq}-${process.pid}`
}

// One container per project, brought up lazily and reused across its sessions.
// The map is a cache; Docker is the source of truth (survives app restarts).
const containerByProject = new Map<string, string>()

// M-LOG-b: session ids with a ticket-generation pass in flight — blocks a second
// concurrent generate for the same session (no double headless pass / dup rows).
const ticketsInFlight = new Set<string>()
/** The exec context every in-container command shares (R3-1): the resolved
 *  remoteUser, that user's REAL home (from the container's passwd), and the
 *  container-side workspace folder. Sessions, terminals, health probes, and
 *  installs all use this one resolution so they can't disagree. */
async function containerExecContext(
  container: ContainerRuntime,
  containerId: string,
  workspace: string
): Promise<{ user?: string; home: string; cwd: string }> {
  const user = await container.resolveUser(containerId)
  const home = await container.resolveHome(containerId, user)
  const cwd = await container.workspaceFolder(workspace)
  return { user: user ?? undefined, home, cwd }
}

/** Copy the host's provider credentials into the container user's WRITABLE
 *  home via docker cp (R3-2): containerized sessions are pre-authenticated,
 *  in-container logins/token refreshes persist, and nothing can write back to
 *  the host. Idempotent — container-local files always win — and it works on
 *  containers built before this feature existed (no rebuild, R2-2). ~/.claude
 *  files stay opt-in via importConfig. */
async function seedContainer(
  container: ContainerRuntime,
  containerId: string,
  workspace: string,
  importConfig: boolean
): Promise<void> {
  const ctx = await containerExecContext(container, containerId, workspace)
  const files = providerSeedFiles(homedir(), { includeClaude: importConfig })
  try {
    await container.seedCredentials(containerId, ctx.user ?? null, ctx.home, files)
  } catch (err) {
    console.error('[seedContainer] credential seeding failed:', (err as Error).message)
    sendToRenderer('app:notice', {
      message: 'copying provider logins into the container failed — run logins in-session if needed'
    })
  }
}

async function ensureContainer(
  container: ContainerRuntime,
  projectId: string,
  workspace: string,
  importConfig = false
): Promise<string> {
  // Docker is the source of truth (Codex P2 — no stale cache fast-path):
  // running -> reuse; stopped -> start it (don't rebuild); none -> build.
  const presence = await container.findPresence(workspace)
  if (presence.state === 'running') {
    containerByProject.set(projectId, presence.id)
    await seedContainer(container, presence.id, workspace, importConfig)
    return presence.id
  }
  if (presence.state === 'stopped') {
    await container.startById(presence.id)
    containerByProject.set(projectId, presence.id)
    await seedContainer(container, presence.id, workspace, importConfig)
    return presence.id
  }
  // Mount the IDE library so in-container sessions can use its skills/
  // workflows/agents. Only when it has content, to avoid binding an empty
  // placeholder dir. (D14)
  const mounts: string[] = []
  const lib = libraryDir()
  if (['skills', 'workflows', 'prompts', 'agents'].some((d) => existsSync(join(lib, d)))) {
    mounts.push(libraryConfigMount(lib))
  }
  const { containerId } = await container.up(workspace, mounts)
  containerByProject.set(projectId, containerId)
  await seedContainer(container, containerId, workspace, importConfig)
  return containerId
}

/** Authoritative running-container id for a project. Docker is the source of
 *  truth (Codex P2 — never trust a cached id that may be stopped/removed); the
 *  cache is refreshed from the query result. */
async function resolveContainerId(
  container: ContainerRuntime,
  projectId: string,
  workspace: string
): Promise<string | undefined> {
  const running = await container.findRunning(workspace)
  if (running) containerByProject.set(projectId, running)
  else containerByProject.delete(projectId)
  return running ?? undefined
}

// VS Code-style auto port forwarding: while a containerized session runs, watch
// the container for newly-listening localhost ports and forward each to the same
// host port (so the host browser reaches in-container OAuth callbacks like :1455
// and any dev server). B5: ONE watcher per CONTAINER, refcounted by the sessions
// using it — a session ending must not tear down forwards another session in the
// same container still needs. The watcher (and its forwards) stop only when the
// last session in that container stops. Forwarding runs through the runtime's
// PortForwardService (M1) rather than a module-level singleton.
const watchers = new Map<string, { watcher: PortWatchHandle; sessions: Set<string> }>()
function startPortWatch(ports: PortForwardService, sessionId: string, containerId: string): void {
  const existing = watchers.get(containerId)
  if (existing) {
    existing.sessions.add(sessionId) // share the one watcher for this container
    return
  }
  const watcher = ports.watch(containerId, {
    onForward: (port) =>
      sendToRenderer('session:status', {
        id: sessionId,
        message: `forwarding container port ${port} → localhost:${port}`
      })
  })
  watchers.set(containerId, { watcher, sessions: new Set([sessionId]) })
  watcher.start()
}
function stopPortWatch(sessionId: string): void {
  for (const [containerId, entry] of watchers) {
    if (!entry.sessions.delete(sessionId)) continue
    if (entry.sessions.size === 0) {
      // last session in this container — tear down
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
  appendFile(historyFile(sessionId), data, () => {
    /* best-effort mirror */
  })
  // Feed the v2 session bus (P0.A): attention/cost (S5) and queue (S6) subscribe
  // to 'output'. All live pty spawns funnel through here, so this is the single
  // choke point that keeps the bus fed regardless of launch path.
  sessionEvents.emitEvent('output', { id: sessionId, chunk: data })
}

// v2 bridge (foundation deviation #1): the legacy launch/archive handlers still
// spawn through ipc.ts rather than launchService, so they must feed the session
// bus themselves until consolidation rewires them. archiveAndEmit archives once
// and emits 'archived' only on a real transition (queue advancement, S6, keys off
// it). emitExit mirrors 'exit' for bus subscribers alongside the renderer event.
function archiveAndEmit(store: Store | undefined, id: string): void {
  const projectId = store?.getSession(id)?.projectId
  const wasArchived = store?.getSession(id)?.status === 'archived'
  store?.archiveSession(id)
  if (!wasArchived && projectId) sessionEvents.emitEvent('archived', { id, projectId })
}
function emitExit(id: string, reason: import('./ptyManager').ExitReason): void {
  sessionEvents.emitEvent('exit', { id, reason })
}

/** After a fresh engine starts for an existing session (reconnect or model swap),
 *  seed it with the session's prior history so it continues with context. The
 *  IDE owns this history (cleaned terminal text) — independent of any provider
 *  CLI's own resume. B12: the primer is typed in once the terminal settles (not on
 *  a blind fixed delay) and is tied to the session's current pty generation, so it
 *  never lands in a killed/replaced session or interleaves the initial render. A
 *  trailing newline submits it. No-op when there's no prior history. */
function seedPrimer(mgr: TerminalRuntime, store: Store | undefined, sessionId: string): void {
  // Gate 1: on resume / model-swap, re-inject the FULL canonical primer —
  // harness → agent → objective → prior history — so the uniform protocol is
  // present after the engine restarts, not just the raw transcript. Falls back to
  // history-only if there's no session row (defensive).
  const s = store?.getSession(sessionId)
  const history = stripAnsi(store?.getTranscript(sessionId) ?? '')
  if (!s) {
    const primer = buildPrimer(store?.getTranscript(sessionId) ?? '')
    if (primer) mgr.primeWhenReady(sessionId, primer + '\n')
    return
  }
  const submitText = composeLaunchPrimer({
    objective: s.objective,
    stage: s.effectiveStage ?? s.desiredStage ?? 'discussion',
    agentRelPath: s.agentRelPath,
    history,
    reviewPayloads: store?.reviewPayloadsForSession(sessionId) ?? []
  })
  if (submitText.trim()) mgr.primeWhenReady(sessionId, submitText + '\n')
}

/** Resolve the running container a session belongs to, if any. Looks the session
 *  up in the store to get its project workspace, then queries Docker. Returns
 *  undefined for host sessions or when no container is running. */
async function containerForSession(
  container: ContainerRuntime,
  store: Store | undefined,
  sessionId: string
): Promise<string | undefined> {
  if (!store) return undefined
  const session = store.allSessions().find((s) => s.id === sessionId)
  if (!session) return undefined
  const project = store.listProjects().find((p) => p.id === session.projectId)
  if (!project) return undefined
  return resolveContainerId(container, project.id, project.localPath)
}

/** Registers all main-process IPC handlers. Thin router — logic lives in managers.
 *  Called exactly once per process (app-scoped; windows come and go on macOS).
 *  `store` may be undefined if persistence failed to initialize; handlers then
 *  no-op writes and return empty reads so the UI still works. */
export function registerIpc(
  runtime: Runtime,
  store?: Store,
  ticketRunner: HeadlessRunner = notEnabledRunner
): void {
  // M1: all platform side effects go through the runtime. `mgr` aliases the
  // terminal runtime, whose method names match the old PtyManager so the many
  // spawn/write/resize/kill/primeWhenReady call sites are unchanged.
  const mgr = runtime.terminal
  const { container, host, ports } = runtime
  ipcMain.handle('ping', () => 'pong')

  // ---- v2 foundation: canonical launcher + feature IPC registrars ----------
  const projectRoot = (id: string): string | undefined => store?.getProject(id)?.localPath
  const launch = new LaunchService({
    runtime,
    store: store!,
    e2eMode: process.env.AGENT_IDE_E2E === '1',
    onData: (id, chunk) => {
      sendToRenderer('pty:data', { id, data: chunk })
    },
    onExit: (id, reason) => sendToRenderer('session:exit', { id, reason })
  })
  const ipcDeps: IpcDeps = { store, runtime, launch, projectRoot, send: sendToRenderer }
  // All v2 registrars register their handlers unconditionally (no-store handlers
  // return typed errors/empties, matching the degraded-mode contract).
  registerBacklogIpc(ipcDeps)
  registerQueueIpc(ipcDeps)
  registerSearchIpc(ipcDeps)
  registerReviewIpc(ipcDeps)
  registerHarnessIpc(ipcDeps)
  registerGitIpc(ipcDeps)
  registerLinearIpc(ipcDeps)
  registerAttentionIpc(ipcDeps)
  if (store) {
    // Reconcile queue + interrupted sessions on startup (R8/R34/R36).
    try {
      launch.reconcileOnBoot()
    } catch (err) {
      console.error('[boot reconcile]', (err as Error).message)
    }
  }

  // Declarative stage/model writes (R27/R28): persist desired, request reconcile.
  ipcMain.handle('session:setStage', (_e, id: unknown, stage: unknown) => {
    if (typeof id !== 'string' || typeof stage !== 'string' || !store) return { error: 'invalid request' }
    if (!['discussion', 'playback', 'fix'].includes(stage)) return { error: 'invalid stage' }
    return launch.setDesiredStage(id, stage as SessionStage)
  })
  ipcMain.handle('session:setModel', (_e, id: unknown, provider: unknown, model: unknown) => {
    if (typeof id !== 'string' || !isProvider(String(provider)) || typeof model !== 'string' || !store)
      return { error: 'invalid request' }
    return launch.setDesiredModel(id, provider as Provider, model)
  })

  // Terminal copy/paste goes through the OS clipboard here in main, NOT the
  // renderer's navigator.clipboard: the async web clipboard needs document focus
  // + transient user activation, which the xterm keydown path can't guarantee, so
  // writes silently no-op (Ctrl+Shift+C "does nothing"). Electron's clipboard is
  // synchronous and has no such requirement.
  ipcMain.handle('clipboard:write', (_e, text: string) => {
    clipboard.writeText(text)
  })
  ipcMain.handle('clipboard:read', () => clipboard.readText())

  // Codex prints a 400 and STAYS at its prompt (it doesn't exit) when the chosen
  // model isn't allowed for a ChatGPT-account login — so there's no crash to
  // catch. Scan the session's output for that specific error and tell the
  // renderer, which then offers the model picker. Gated on the error marker so we
  // don't parse every chunk. `sessionModel` lets the event name the bad model.
  const sessionModel = new Map<string, string>()
  const detectModelRejection = (id: string, data: string): void => {
    if (!data.includes('invalid_request_error')) return
    if (!/not supported when using Codex with a ChatGPT account/.test(data)) return
    sendToRenderer('session:model-rejected', { id, model: sessionModel.get(id) ?? '', message: data.trim() })
  }

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
      try {
        appendFileSync(process.env.AGENT_IDE_OPEN_LOG, url + '\n')
      } catch {
        /* best-effort */
      }
    }
    try {
      // If a containerized session printed a localhost URL, forward that port out
      // to the host first so the browser can reach it. Bounded so a slow/hung
      // forward can't block opening the browser (Codex P4).
      const port = loopbackPort(url)
      if (port && sessionId) {
        const containerId = await containerForSession(container, store, sessionId)
        if (containerId) {
          // Ad-hoc forward for an opened URL; owned by the container so it isn't
          // torn down when one session ends (B5). Bounded so a slow/hung forward
          // can't block opening the browser (Codex P4).
          await Promise.race([
            ports.ensure(containerId, port, `manual:${containerId}`),
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

  // native directory picker (F2) — parented to the focused window when one exists
  ipcMain.handle('dialog:openDirectory', async () => {
    const parent = BrowserWindow.getFocusedWindow()
    const opts = {
      properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[]
    }
    const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts)
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
  // (projectRoot is declared once at the top of registerIpc for the v2 deps.)

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
  // The effort forced by AGENT_IDE_EFFORT, if any. The renderer can't read
  // process.env, and the picker needs to know so it can lock the row and show
  // WHY a pick won't move (rather than silently ignoring the user's click).
  ipcMain.handle('effort:forced', (): Effort | null => resolveEffort(null) ?? null)

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
      counts: {
        prompts: lib.prompts.length,
        skills: lib.skills.length,
        workflows: lib.workflows.length,
        agents: lib.agents.length
      }
    }
  })
  // Create an agent file in the library (validated at the boundary; exclusive
  // write — duplicates are an error, never an overwrite).
  ipcMain.handle('library:addAgent', (_e, raw: unknown) => addAgent(raw))
  // Sync: pull if already a clone; otherwise clone the given repo (owner/name via
  // gh, or any git URL) into the (empty) library dir. `repo` is optional when a
  // clone already exists. Returns the refreshed contents (or an error).
  ipcMain.handle('library:sync', async (_e, repo?: string): Promise<{ ok?: true; error?: string }> => {
    const dir = libraryDir()
    try {
      if (libraryIsClone(dir)) {
        await pullRepo(dir)
      } else if (repo) {
        // Local-first library: locally-added items (e.g. agents) may exist before
        // any clone. Refuse to clone over them — never clobber local files.
        if (existsSync(dir) && readdirSync(dir).some((n) => !n.startsWith('.'))) {
          return {
            error:
              'library folder has local items but is not a clone — clone manually or move the items first'
          }
        }
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
  ipcMain.handle(
    'file:write',
    (_e, projectId: string, path: string, content: string): { ok?: true; error?: string } => {
      const file = resolveProjectFile(projectRoot, projectId, path)
      if (!file) return { error: 'path outside project' }
      try {
        writeFileSync(file, content, 'utf8')
        return { ok: true }
      } catch (err) {
        return { error: (err as Error).message }
      }
    }
  )

  // rename a session (F3/F6)
  ipcMain.handle('session:rename', (_e, id: string, name: string) => {
    store?.renameSession(id, name)
  })

  // close + archive a session: kill its pty and persist archived status (F6).
  ipcMain.handle('session:archive', (_e, id: string) => {
    mgr.kill(id)
    archiveAndEmit(store, id)
  })

  // M-LOG-a (§4.1): advance a task's lifecycle status (open→finished→deployed→
  // ticketed), forward-only. Product chats marked 'finished' also export their raw
  // log entry (§4.3); analysis chats just advance the status (no log). Returns the
  // written log path (product+finished) or {ok}, or {error} on a bad transition.
  ipcMain.handle(
    'task:setStatus',
    async (_e, id: unknown, to: unknown): Promise<{ ok?: true; logPath?: string; error?: string }> => {
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
    }
  )

  // M-LOG-b (§4.4): generate a roadmap ticket for a deployed product chat via the
  // headless addendum pass. Crash-safe (§4.6-16): the session is moved to
  // 'deployed' first; the ticket runs; only on success is it written + the status
  // advanced to 'ticketed'. On ANY failure the session STAYS 'deployed' with a
  // working retry (this handler is idempotent) and the transcript is never
  // mutated. Returns the ticket id/path or an error to retry.
  ipcMain.handle(
    'task:generateTicket',
    async (
      _e,
      id: unknown
    ): Promise<{ ok?: true; ticketId?: string; ticketPath?: string; error?: string }> => {
      if (typeof id !== 'string' || !store) return { error: 'invalid request' }
      const session = store.getSession(id)
      if (!session) return { error: 'unknown session' }
      if (session.taskKind !== 'product') return { error: 'only product tasks generate tickets' }
      // Idempotency guard: if this task already has a ticket, return it instead of
      // regenerating (which would duplicate the row + re-run the billed pass). Also
      // repair a stale 'deployed' status left by a pre-transaction crash.
      const existing = store.getTicketBySession(id)
      if (existing) {
        if (session.taskStatus !== 'ticketed') store.setTaskStatus(id, 'ticketed')
        return { ok: true, ticketId: existing.id }
      }
      // In-flight guard: a second concurrent call for the same session is refused
      // (e.g. a double-click), so we never run two headless passes at once.
      if (ticketsInFlight.has(id)) return { error: 'ticket generation already in progress' }
      ticketsInFlight.add(id)
      // Advance to 'deployed' if not already past it (forward-only).
      if ((session.taskStatus ?? 'open') !== 'deployed' && session.taskStatus !== 'ticketed') {
        try {
          validateTaskTransition(session.taskStatus, 'deployed')
          store.setTaskStatus(id, 'deployed')
        } catch {
          /* already past */
        }
      }
      // Uncapped read: summarization must see the WHOLE transcript, not the 256KiB
      // UI-replay tail (chunking handles the length).
      const transcript = stripAnsi(store.getTranscript(id, Number.POSITIVE_INFINITY))
      try {
        const { fields, bodyMd } = await generateTicket(ticketRunner, session, transcript)
        const createdAt = Date.now()
        const ticketId = `ticket-${id}` // deterministic → a retry upserts, never duplicates
        const ticketPath = writeTicketFile(session.projectId, id, bodyMd)
        if (!ticketPath) return { error: 'ticket file write failed — retry available' }
        store.finalizeTicket({
          id: ticketId,
          sessionId: id,
          projectId: session.projectId,
          subkind: fields.subkind,
          title: fields.title,
          bodyMd,
          fieldsJson: JSON.stringify(fields),
          createdAt
        }) // row + 'ticketed' in one transaction, only after the file exists
        return { ok: true, ticketId, ticketPath }
      } catch (err) {
        // stays 'deployed' — retry available; transcript untouched.
        return { error: (err as Error).message }
      } finally {
        ticketsInFlight.delete(id)
      }
    }
  )

  // M-LOG-b (§4.5.4): the project Log list — raw entries + generated tickets.
  ipcMain.handle('log:tickets', (_e, projectId: unknown) =>
    typeof projectId === 'string' && store ? store.getTickets(projectId) : []
  )

  // Permanently delete a session (from the home board's Archived view). Removes
  // the DB row + its transcript and moves the on-disk history file to a Bin/
  // (never-rm policy). Kills any lingering pty first (defensive — archived
  // sessions normally have none). Irreversible from the app; the renderer confirms.
  ipcMain.handle('session:delete', (_e, id: string) => {
    mgr.kill(id)
    store?.deleteSession(id)
    removeHistory(id)
  })

  // F13: open a plain shell session (no agent) in the project's context. Uses the
  // v2 bus-emitting exit path (archiveAndEmit/emitExit) + S1 backlog binding.
  ipcMain.handle(
    'terminal:open',
    async (
      _e,
      req: { projectId: string; cwd: string; name: string; useContainer: boolean }
    ): Promise<Session> => {
      const id = `term-${newSessionId()}`
      let shell = hostShell()
      let args: string[] = []
      let cwd = req.cwd
      if (req.useContainer) {
        // Don't silently downgrade to a host shell (Codex P2): bring the container
        // up if needed so the terminal really runs inside it. Exec with the same
        // user/HOME/workspace context agent sessions use (R3-1).
        const containerId = await ensureContainer(container, req.projectId, req.cwd)
        const ctx = await containerExecContext(container, containerId, req.cwd)
        shell = 'docker'
        args = containerExecArgv(containerId, 'bash', [], {
          user: ctx.user,
          cwd: ctx.cwd,
          env: { HOME: ctx.home }
        })
        cwd = req.cwd
      }
      const now = Date.now()
      const session: Session = {
        id,
        projectId: req.projectId,
        provider: 'codex', // provider unused for terminals; see isTerminal()
        model: 'shell',
        objective: req.name || 'terminal',
        status: 'running',
        createdAt: now,
        updatedAt: now,
        useContainer: req.useContainer === true
      }
      store?.saveSession(session)
      // S1: a plain terminal can also carry a "Work on this" backlog selection.
      if (store)
        bindLaunchBacklog(store, id, req.projectId, (req as { backlogItemIds?: unknown }).backlogItemIds)
      mgr.spawn(
        { id, shell, args, cwd, env: {} },
        (data) => {
          sendToRenderer('pty:data', { id, data })
          recordOutput(store, id, data)
        },
        ({ reason }) => {
          archiveAndEmit(store, id)
          emitExit(id, reason)
          sendToRenderer('session:exit', { id, reason })
        }
      )
      return session
    }
  )

  // F14: explicitly bring up the project's devcontainer once (warm it before
  // launching sessions). Returns the container id. Reused by all its sessions.
  ipcMain.handle(
    'container:start',
    async (_e, projectId: string, workspace: string, importConfig: boolean) => {
      if (!(await container.hasCli())) {
        throw new Error('devcontainer CLI not found. Install it: npm i -g @devcontainers/cli')
      }
      sendToRenderer('container:status', { projectId, state: 'starting' })
      try {
        const containerId = await ensureContainer(container, projectId, workspace, importConfig)
        sendToRenderer('container:status', { projectId, state: 'running' })
        return containerId
      } catch (err) {
        sendToRenderer('container:status', { projectId, state: 'error' })
        throw err
      }
    }
  )
  // Container status for this project, by Docker state (accurate across app
  // restarts): 'running' | 'stopped' (built but exited) | 'none' (never built).
  ipcMain.handle('container:status', async (_e, _projectId: string, workspace: string) => {
    return (await container.findPresence(workspace)).state
  })

  // Stop (not remove) the project's running container — reversible, preserves its
  // state, so the next start is a fast restart rather than a rebuild. `docker stop`
  // terminates any `docker exec` sessions running inside it: each session's pty
  // exits 'crashed' → flips to idle + reconnectable (history retained) and its port
  // watcher is torn down via the normal exit handler. We also drop the cached id
  // so a subsequent launch re-resolves Docker truth. The renderer warns the user
  // about live sessions before calling this. Returns the new state for the button.
  ipcMain.handle(
    'container:stop',
    async (_e, projectId: string, workspace: string): Promise<'stopped' | 'none'> => {
      const id = await container.findRunning(workspace)
      if (!id) {
        // Nothing running — report the real current state so the UI stays accurate.
        containerByProject.delete(projectId)
        const state = (await container.findPresence(workspace)).state
        sendToRenderer('container:status', { projectId, state })
        return state === 'none' ? 'none' : 'stopped'
      }
      await container.stopById(id)
      containerByProject.delete(projectId)
      sendToRenderer('container:status', { projectId, state: 'stopped' })
      return 'stopped'
    }
  )

  // F16: external-service connectivity for the status bar (vercel/supabase/
  // github/resend). Probe all in parallel (timeboxed — these CLIs can hang).
  ipcMain.handle('service:health', () => probeAllServices())

  // F16: connect a service — open a HOST terminal session running its login
  // command (interactive browser/device flow), like provider:login. Returns the
  // session id so the renderer can surface it as the active terminal. cwd is the
  // open project's path (or home) just to give the shell a sensible directory.
  ipcMain.handle('service:login', (_e, service: ServiceName, cwd: string): string => {
    if (!SERVICES.includes(service)) throw new Error(`bad service: ${service}`)
    const id = `login-${service}-${newSessionId()}`
    const { cmd, args } = serviceLoginArgv(service)
    mgr.spawn(
      { id, shell: cmd, args, cwd: cwd || homedir(), env: {} },
      (data) => sendToRenderer('pty:data', { id, data }),
      ({ reason }) => sendToRenderer('session:exit', { id, reason })
    )
    return id
  })

  // F8: provider connection health, in the project's context. An explicit
  // useContainer from the renderer wins (a host-mode user must not see the
  // container's health just because one is running); absent → auto-detect.
  ipcMain.handle(
    'provider:health',
    async (_e, provider: Provider, projectId: string, cwd: string, useContainer?: unknown) => {
      if (!isProvider(provider)) throw new Error(`bad provider: ${provider}`)
      if (useContainer === false) return host.probeHealth(provider, {})
      const containerId = await resolveContainerId(container, projectId, cwd)
      if (useContainer === true && !containerId) return 'unknown' // container context requested but not running
      if (!containerId) return host.probeHealth(provider, {})
      const ctx = await containerExecContext(container, containerId, cwd)
      return host.probeHealth(provider, { containerId, ...ctx })
    }
  )

  // F10: run an interactive CLI login as a terminal session, in project context.
  ipcMain.handle(
    'provider:login',
    async (_e, provider: Provider, projectId: string, cwd: string): Promise<string> => {
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
        (data) => sendToRenderer('pty:data', { id, data }),
        ({ reason }) => sendToRenderer('session:exit', { id, reason })
      )
      return id
    }
  )

  // F9: install a provider CLI inside the project's container (with renderer confirm).
  ipcMain.handle('provider:install', async (_e, provider: Provider, projectId: string, cwd: string) => {
    if (!isProvider(provider)) throw new Error(`bad provider: ${provider}`)
    const containerId = await resolveContainerId(container, projectId, cwd)
    if (!containerId) throw new Error('no running container for this project')
    await host.installInContainer(provider, containerId)
    const ctx = await containerExecContext(container, containerId, cwd)
    return host.probeHealth(provider, { containerId, ...ctx })
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
  // Whether a live pty exists for a session — a reopened window uses this to
  // ATTACH to surviving sessions instead of offering a killing "reconnect".
  ipcMain.handle('pty:alive', (_e, id: string) => mgr.has(id))
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => mgr.resize(id, cols, rows))
  ipcMain.on('pty:kill', (_e, id: string) => mgr.kill(id))

  // launch a real provider session (interactive CLI, subscription-safe per NN0).
  // Containerized projects run the CLI INSIDE the devcontainer with auto-approve
  // (NN2 + D26); host projects run on the host and prompt for approval.
  ipcMain.handle('session:launch', async (_e, raw: unknown): Promise<Session> => {
    // B9: validate the renderer payload in main (types don't cross IPC). Enforces
    // provider/model membership, project ownership, field types + length caps.
    const req: LaunchRequest = validateLaunchRequest(
      raw,
      (id) => !!store?.getProject(id),
      (rel) => isRegisteredAgent(rel)
    )
    const id = newSessionId()

    // Build the provider invocation. autoApprove == running in a container.
    const { cmd, args } = launchArgv({
      provider: req.provider,
      model: req.model,
      autoApprove: req.useContainer,
      effort: resolveEffort(req.effort)
    })

    let shell = cmd
    let spawnArgs = args
    let cwd = req.cwd
    let watchContainer: string | undefined

    if (req.useContainer) {
      if (!(await container.hasCli())) {
        throw new Error('devcontainer CLI not found. Install it: npm i -g @devcontainers/cli')
      }
      sendToRenderer('session:status', { id, message: 'starting container…' })
      const containerId = await ensureContainer(container, req.projectId, req.cwd, req.importConfig)
      // run inside the container as its non-root remoteUser (root would break
      // auto-approve: claude --dangerously-skip-permissions refuses euid 0),
      // in the container-side workspace folder, with HOME set (R3-1).
      const ctx = await containerExecContext(container, containerId, req.cwd)
      shell = 'docker'
      spawnArgs = containerExecArgv(containerId, cmd, args, {
        user: ctx.user,
        cwd: ctx.cwd,
        env: { HOME: ctx.home }
      })
      cwd = req.cwd // host-side cwd of the docker process itself
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
      taskStatus: req.taskKind ? 'open' : null,
      useContainer: req.useContainer,
      // S8: persist the agent preset so the session chip can render its name and
      // resume/relaunch carry it forward.
      agentRelPath: req.agentRelPath ?? null
    }
    // Spawn FIRST; only persist once the pty actually started (Codex P2 — a
    // failed spawn must not leave a persisted "running" ghost session).
    sessionModel.set(id, req.model)
    try {
      mgr.spawn(
        { id, shell, args: spawnArgs, cwd, env: {} },
        (data) => {
          sendToRenderer('pty:data', { id, data })
          recordOutput(store, id, data)
          detectModelRejection(id, data)
        },
        ({ reason }) => {
          // History always retained (item 7). Clean close -> archived; crash ->
          // NOT archived (status idle) so it stays reconnectable (F4 / Codex P1).
          if (reason === 'closed') archiveAndEmit(store, id)
          else store?.setSessionStatus(id, 'idle')
          emitExit(id, reason)
          stopPortWatch(id)
          sendToRenderer('session:exit', { id, reason })
        }
      )
    } catch (err) {
      throw new Error(`failed to start ${req.provider} session: ${(err as Error).message}`)
    }
    store?.saveSession(session)
    // S1: bind any "Work on this" backlog selection to the new session. The field
    // rides along the launch payload (bridge passes req through untouched); binding
    // moves each item to sessionState 'in-session' (Store recompute).
    if (store)
      bindLaunchBacklog(store, id, req.projectId, (raw as { backlogItemIds?: unknown }).backlogItemIds)

    // P0.D primer: seed the session with the harness protocol, the agent preset
    // body (S8 — trusted, auto-submitted AFTER the harness section), and the
    // objective. Delivered once the terminal settles (primeWhenReady) so it never
    // interleaves the CLI's initial render. Only agent launches add the agent
    // section; a plain launch primes harness + objective.
    const primer = composeLaunchPrimer({
      objective: session.objective,
      agentRelPath: req.agentRelPath,
      agentLabel: session.objective
    })
    if (primer.trim()) mgr.primeWhenReady(id, primer + '\n')

    // Auto-forward any localhost port the in-container agent opens (OAuth :1455,
    // dev servers, …) so the host browser can reach it — VS Code-style.
    if (watchContainer) startPortWatch(ports, id, watchContainer)

    return session
  })

  // Reconnect a session. The IDE owns the conversation (not the provider CLI), so
  // we DON'T use provider "resume last/continue" flags — those grab whichever
  // conversation the CLI saw last, which made independent sessions of the same
  // provider bleed into one another. Instead we launch the engine FRESH and seed
  // it with this session's own stored history (cleaned). Runs in the SAME context
  // as the original (container vs host, Codex P1). Optional model override lets
  // "change model" reuse this exact path to move the conversation to another engine.
  ipcMain.handle(
    'session:resume',
    async (
      _e,
      rawSession: unknown,
      rawCwd: unknown,
      rawUseContainer: unknown,
      rawOverride?: unknown
    ): Promise<Session> => {
      // B9: validate the renderer payload in main. The session's provider/model/
      // status are membership-checked; an optional model override is validated as a
      // fresh launch request (provider + model membership) reusing the same guards.
      const s: Session = validateResumeSession(rawSession)
      const cwd = typeof rawCwd === 'string' ? rawCwd : ''
      // Explicit renderer choice wins; absent → the session's persisted context
      // (B6), so a restart can't silently move a container session to the host.
      const stored = store?.getSession(s.id)?.useContainer
      const useContainer = typeof rawUseContainer === 'boolean' ? rawUseContainer : stored === true
      let modelOverride: { provider: Provider; model: string } | undefined
      if (rawOverride !== undefined) {
        const ov = validateResumeSession({
          ...s,
          provider: (rawOverride as { provider?: unknown }).provider,
          model: (rawOverride as { model?: unknown }).model
        })
        modelOverride = { provider: ov.provider, model: ov.model }
      }
      const provider = modelOverride?.provider ?? s.provider
      let model = modelOverride?.model ?? s.model
      if (!isProvider(provider)) throw new Error(`bad provider: ${provider}`)
      // A session saved before the provider's model line rotated (e.g. gpt-5-codex,
      // now retired) would relaunch a dead id and 400. If the stored model is no
      // longer launchable, fall back to the provider's current default so the
      // resume succeeds instead of dropping the user at a rejected prompt.
      if (!isKnownModel(provider, model)) {
        const fallback = defaultModel(provider)
        console.warn(`[resume] stale model ${model} for ${provider} → ${fallback}`)
        model = fallback
      }
      sessionModel.set(s.id, model)
      // Fresh interactive launch (NOT resumeArgv). autoApprove == in a container.
      // Effort comes from the persisted session so a reconnect keeps the level
      // the session was launched with (AGENT_IDE_EFFORT still outranks it).
      const { cmd, args } = launchArgv({
        provider,
        model,
        autoApprove: useContainer,
        effort: resolveEffort(store?.getSession(s.id)?.effort)
      })
      let shell = cmd
      let spawnArgs = args
      let watchContainer: string | undefined
      if (useContainer) {
        const containerId = await resolveContainerId(container, s.projectId, cwd)
        if (!containerId) throw new Error('cannot reconnect: the project container is not running')
        const ctx = await containerExecContext(container, containerId, cwd)
        shell = 'docker'
        spawnArgs = containerExecArgv(containerId, cmd, args, {
          user: ctx.user,
          cwd: ctx.cwd,
          env: { HOME: ctx.home }
        })
        watchContainer = containerId
      }
      mgr.spawn(
        { id: s.id, shell, args: spawnArgs, cwd, env: {} },
        (data) => {
          sendToRenderer('pty:data', { id: s.id, data })
          recordOutput(store, s.id, data)
          detectModelRejection(s.id, data)
        },
        ({ reason }) => {
          stopPortWatch(s.id)
          if (reason === 'closed') archiveAndEmit(store, s.id)
          else store?.setSessionStatus(s.id, 'idle')
          emitExit(s.id, reason)
          sendToRenderer('session:exit', { id: s.id, reason })
        }
      )
      // Seed the fresh engine with this session's prior history (context continuity).
      seedPrimer(mgr, store, s.id)
      if (watchContainer) startPortWatch(ports, s.id, watchContainer)
      const resumed: Session = {
        ...s,
        provider,
        model,
        status: 'running',
        updatedAt: Date.now(),
        useContainer
      }
      store?.saveSession(resumed)
      return resumed
    }
  )

  // Tear down port watchers + host-side relays on shutdown (container relays die
  // with the container), AWAITED (bounded) so Electron can't exit before the
  // relays are actually gone. Avoids leaking relay processes across restarts.
  app.on(
    'before-quit',
    createQuitCoordinator(
      async () => {
        const stops = [...watchers.values()].map(({ watcher }) => watcher.stop())
        watchers.clear()
        await Promise.all(stops)
        await ports.disposeAll()
        store?.flush() // B6: persist any buffered transcript chunks before exit
      },
      () => app.exit(0)
    )
  )
}

/** Bounded, awaited shutdown. The first quit attempt is intercepted; cleanup
 *  runs (capped at `timeoutMs`) and then the real exit fires. Injected deps keep
 *  it unit-testable without an Electron app. */
export function createQuitCoordinator(
  cleanup: () => Promise<unknown>,
  exit: () => void,
  timeoutMs = 2500
): (e: { preventDefault(): void }) => void {
  let done = false
  return (e) => {
    if (done) return
    done = true
    e.preventDefault()
    void Promise.race([
      cleanup().catch(() => {
        /* best-effort — exit regardless */
      }),
      new Promise((r) => setTimeout(r, timeoutMs))
    ]).then(() => exit())
  }
}
