import './cockpit.css'
import { isTerminalSession } from '@shared/types'
import type {
  Provider,
  Project,
  Session,
  SessionStage,
  TaskKind,
  TaskSubkind,
  GitStatusSummary,
  GitDiff,
  CostSummary,
  AttentionState
} from '@shared/types'
import { initialState, liveCounts, liveSessionsFor, type AppState } from './state'
import { ProjectRail } from './components/ProjectRail'
import { Cockpit, type ProviderHealth } from './components/Cockpit'
import { SupervisionView, type OpenFile, type OpenReport, type ActiveTab } from './components/SupervisionView'
import { Explorer, type FileNode } from './components/Explorer'
import { ModelPicker } from './components/ModelPicker'
import { LibraryPanel } from './components/LibraryPanel'
import {
  LinearPanel,
  type LinearStatus,
  type LinearBacklogRow,
  type WritebackPreview
} from './components/LinearPanel'
import { AgentForm } from './components/AgentForm'
import type { LibraryCategory, LibraryContents, LibraryItem } from '@shared/types'
import { RepoPicker } from './components/RepoPicker'
import { SessionTerminal } from './components/SessionTerminal'
import { AllSessions, type BoardMode } from './components/AllSessions'
import { StatusBar } from './components/StatusBar'
import { SearchOverlay } from './components/SearchOverlay'
import { BacklogView, type BacklogLayout } from './components/BacklogView'
import { BacklogModal } from './components/BacklogModal'
import type {
  BacklogItem,
  BacklogCreateInput,
  BacklogUpdateInput,
  BacklogManualStatus,
  QueueItem
} from '@shared/types'
import { runAdvanceFlow, nextStage, effectiveStageOf } from './components/StageChip'
import { openHarnessEditor } from './components/HarnessEditor'
import { QueueDrawer } from './components/QueueDrawer'
import { HandoffReview } from './components/HandoffReview'
import { modelsFor, loadModels } from './models'
import { showMenu, promptText, chooseOption, flash } from './ui'
import type { ServiceName, ServiceStatus } from '@shared/types'

const root = document.getElementById('app')!
const state: AppState = initialState()

// ---- S6 orchestration: queue, split view, handoff-review state ----------------
// Split view (S6): show two session panes side by side in the cockpit. The second
// pane's session id and which pane is focused (writes/inserts target it).
let splitOn = false
let secondSessionId: string | null = null
let focusedPane: 'primary' | 'second' = 'primary'
// Pending-review counts per session (S6/S2), refreshed from main. sessionId →
// {count, chars, inFix}. Drives the "Review & insert" affordance on each pane.
const reviewPending = new Map<string, { count: number; chars: number; inFix: boolean }>()

// Refresh a session's pending-review summary from main, then re-render.
function refreshReview(sessionId: string, inFix = false): void {
  window.agentIDE
    .reviewPending(sessionId)
    .then((r) => {
      if (r.totalChars > 0 && r.sections.length > 0) {
        reviewPending.set(sessionId, { count: r.sections.length, chars: r.totalChars, inFix })
      } else {
        reviewPending.delete(sessionId)
      }
      render()
    })
    .catch(() => {
      /* store unavailable */
    })
}

// Main tells us when a session's pending-review set changes (handoff registered,
// or review:insert cleared it).
window.agentIDE.onReviewChanged?.(({ sessionId }) => refreshReview(sessionId))
// Main tells us when a project's queue changed (advancement, enqueue, etc.).
window.agentIDE.onQueueChanged?.(({ projectId }) => {
  if (currentProject()?.id === projectId) render()
})

// Sessions whose process died (F4). Cleared when reconnected/relaunched.
const reconnect = new Set<string>()
// Last-known provider connection health, per provider (F8/F9).
const health: Partial<Record<Provider, ProviderHealth>> = {}
// Remembered run-context choice per project (F11): true=container, false=host.
const runInContainer = new Map<string, boolean>()
// Container state per project (F14).
const containerState = new Map<string, 'none' | 'stopped' | 'starting' | 'running' | 'error'>()
// Home board view: live sessions (default) or archived (for cleanup/delete).
let boardMode: BoardMode = 'live'
window.agentIDE.onContainerStatus?.(({ projectId, state: s }) => {
  containerState.set(projectId, s)
  render()
})

// S5 attention + cost — ephemeral badges. Attention state is main-process only;
// the map holds only currently-flagged sessions. Cost summaries are pulled per
// session on a session:cost signal (the event carries only the id).
const attention = new Map<string, Exclude<AttentionState, null>>()
const costs = new Map<string, CostSummary>()
window.agentIDE.onAttention?.(({ sessionId, state: st }) => {
  if (st === null) attention.delete(sessionId)
  else attention.set(sessionId, st)
  render()
})
window.agentIDE.onCost?.(({ sessionId }) => {
  window.agentIDE
    .costForSession(sessionId)
    .then((c) => {
      if (c && !('error' in c)) {
        costs.set(sessionId, c as CostSummary)
        render()
      }
    })
    .catch(() => {
      /* cost unavailable — chip stays hidden */
    })
})

// Library contents (D14), loaded once at boot; undefined → pills show "—".
let library: LibraryContents | undefined
function loadLibrary() {
  window.agentIDE
    .libraryList()
    .then((lib) => {
      library = lib
      render()
    })
    .catch(() => {
      /* library unavailable */
    })
}

// ---- S1 Backlog tab state ----------------------------------------------------
// Items for the current project, loaded on demand. Layout (grid⇄table) persists
// in localStorage. `backlogSelected` holds "Work on this" selection (per project;
// cleared when the project changes).
const backlogItems = new Map<string, BacklogItem[]>() // projectId → items
const backlogSelected = new Set<string>() // selected item ids
const BK_LAYOUT_KEY = 'agentide.backlog.layout'
function backlogLayout(): BacklogLayout {
  return localStorage.getItem(BK_LAYOUT_KEY) === 'table' ? 'table' : 'grid'
}
function setBacklogLayout(next: BacklogLayout) {
  localStorage.setItem(BK_LAYOUT_KEY, next)
  render()
}

function loadBacklog(projectId: string, force = false) {
  if (backlogItems.has(projectId) && !force) return
  if (!backlogItems.has(projectId)) backlogItems.set(projectId, [])
  window.agentIDE
    .backlogList(projectId)
    .then((items) => {
      backlogItems.set(projectId, items)
      render()
    })
    .catch(() => {})
}

// App-level notices from main (container mount remediation, etc.).
window.agentIDE.onNotice?.(({ message }) => flash(message, 4200))

// F16: external-service connectivity (status bar). Probed on startup + on demand.
let serviceStatus: Partial<Record<ServiceName, ServiceStatus>> = {}
let serviceChecking = false
function probeServices() {
  serviceChecking = true
  render()
  window.agentIDE
    .serviceHealth()
    .then((s) => {
      serviceStatus = s
    })
    .catch(() => {
      /* leave as-is */
    })
    .finally(() => {
      serviceChecking = false
      render()
    })
}
// Re-check a single service (after a connect, or on clicking an online chip).
function recheckService(_service: ServiceName) {
  probeServices()
}
// Open a login terminal for a service, then re-check shortly after.
function connectService(service: ServiceName) {
  const cwd = currentProject()?.localPath ?? ''
  window.agentIDE
    .serviceLogin(service, cwd)
    .then((id) => {
      // Surface the login as a terminal session so the user can complete the flow.
      const now = Date.now()
      const sess: Session = {
        id,
        projectId: state.currentProjectId ?? '',
        provider: 'codex',
        model: 'login',
        objective: `${service} login`,
        status: 'running',
        createdAt: now,
        updatedAt: now
      }
      launchedSessions.add(id)
      state.sessions.push(sess)
      state.activeSessionId = id
      state.view = 'cockpit'
      render()
    })
    .catch((err) => console.error('service login failed', err))
}

// F4: a session's pty exited. History is always kept; a crash flags reconnect.
window.agentIDE.onSessionExit(({ id, reason }) => {
  const s = state.sessions.find((x) => x.id === id)
  if (!s) return
  if (reason === 'crashed') {
    reconnect.add(id)
  } else {
    s.status = 'archived'
  }
  render()
})

// The provider rejected the session's model (Codex model not on a ChatGPT-account
// plan). Codex stays at its prompt, so there's no crash — surface it and offer to
// pick another model. The 400 line can repeat in the stream; only prompt once.
const modelRejectedOnce = new Set<string>()
window.agentIDE.onSessionModelRejected(async ({ id, model }) => {
  if (modelRejectedOnce.has(id)) return
  modelRejectedOnce.add(id)
  const s = state.sessions.find((x) => x.id === id)
  if (!s) return
  const choice = await chooseOption<'pick'>(
    'Model not available',
    [{ label: 'Pick another model', value: 'pick', primary: true }],
    undefined,
    `“${model || s.model}” isn't available on your plan for ${s.provider}. Choose a different model to continue this session.`
  )
  if (choice?.value === 'pick') {
    modelRejectedOnce.delete(id)
    await changeModelFlow(s)
  }
})

// Cache one terminal element per session so re-renders don't respawn the pty.
// Terminals are ALWAYS attach-only: the pty is spawned in the main process
// (session:launch / terminal:open / session:resume). The renderer never spawns
// raw shells (Codex P1 — no arbitrary pty:spawn capability).
const terminals = new Map<string, HTMLElement>()
const launchedSessions = new Set<string>()
function terminalFor(sessionId: string): HTMLElement {
  let el = terminals.get(sessionId)
  if (!el) {
    el = SessionTerminal(sessionId)
    terminals.set(sessionId, el)
  }
  return el
}
/** Drop a cached terminal and dispose its listeners/resources (Codex P2). */
function disposeTerminal(sessionId: string) {
  const el = terminals.get(sessionId) as (HTMLElement & { __dispose?: () => void }) | undefined
  el?.__dispose?.()
  terminals.delete(sessionId)
}

function activityBar(): HTMLElement {
  const el = document.createElement('div')
  el.className = 'activity'
  // Cockpit + Backlog are clickable top-level views (project-scoped); 🔍 opens
  // the ⌘K search overlay (S7); ▷ opens the session queue drawer (S6).
  const cockpitTab = document.createElement('div')
  cockpitTab.className = 'ic' + (state.view === 'cockpit' ? ' on' : '')
  cockpitTab.textContent = '🗂'
  cockpitTab.title = 'Cockpit'
  cockpitTab.onclick = () => {
    if (currentProject()) {
      state.view = 'cockpit'
      render()
    }
  }
  el.appendChild(cockpitTab)

  const backlogTab = document.createElement('div')
  backlogTab.className = 'ic backlog-tab' + (state.view === 'backlog' ? ' on' : '')
  backlogTab.textContent = '📋'
  backlogTab.title = 'Backlog'
  backlogTab.onclick = () => {
    if (currentProject()) {
      state.view = 'backlog'
      render()
    }
  }
  el.appendChild(backlogTab)

  const searchTab = document.createElement('div')
  searchTab.className = 'ic'
  searchTab.textContent = '🔍'
  searchTab.title = 'Search (⌘K)'
  searchTab.onclick = () => openSearch()
  el.appendChild(searchTab)

  const splitTab = document.createElement('div')
  splitTab.className = 'ic'
  splitTab.textContent = '⑂'
  el.appendChild(splitTab)

  const queueTab = document.createElement('div')
  queueTab.className = 'ic queue-ic'
  queueTab.textContent = '▷'
  queueTab.title = 'Session queue'
  queueTab.onclick = () => {
    if (currentProject()) void openQueueDrawer()
  }
  el.appendChild(queueTab)
  const sp = document.createElement('div')
  sp.className = 'sp'
  el.appendChild(sp)
  // S3: harness editor — the uniform Discussion→Playback→Fix protocol. Reachable
  // from the settings cog (home + cockpit both render the activity bar).
  const harness = document.createElement('div')
  harness.className = 'ic'
  harness.textContent = '📜'
  harness.title = 'Edit session harness'
  harness.onclick = () => {
    void openHarnessEditor({
      get: () => window.agentIDE.harnessGet(),
      set: (t) => window.agentIDE.harnessSet(t)
    })
  }
  el.appendChild(harness)
  const cog = document.createElement('div')
  cog.className = 'ic'
  cog.textContent = '⚙'
  el.appendChild(cog)
  return el
}

function currentProject(): Project | null {
  return state.projects.find((p) => p.id === state.currentProjectId) ?? null
}

// S8: resolve a session's agent preset (session.agentRelPath) to a display name
// for its chip, from the loaded library. Falls back to the file basename so a
// chip still renders if the agent was removed from the library after launch.
function agentNameFor(session: Session): string | null {
  const rel = session.agentRelPath
  if (!rel) return null
  const match = library?.agents.find((a) => a.relPath === rel)
  if (match) return match.name
  return rel.replace(/^agents\//, '').replace(/\.md$/, '')
}

/** S5: project ids that have at least one session flagged 'input' (needs the
 *  user) — drives the rail attention dot. Idle-only flags don't raise it. */
function attentionProjectSet(): Set<string> {
  const out = new Set<string>()
  for (const [id, st] of attention) {
    if (st !== 'input') continue
    const s = state.sessions.find((x) => x.id === id)
    if (s) out.add(s.projectId)
  }
  return out
}

// File tree per project, loaded lazily from the real filesystem.
const trees = new Map<string, FileNode[]>()
function loadTree(projectId: string) {
  if (trees.has(projectId)) return
  trees.set(projectId, [])
  window.agentIDE.fsTree(projectId).then((t) => {
    trees.set(projectId, t.nodes as FileNode[])
    render()
  })
}

// ---- S4 git awareness (read-only) --------------------------------------------
// Per-project branch/dirty summary (rail badge) + working-tree diff (Diff tab).
// Both are fetched lazily on project open; `gitLoaded` guards against refetching
// every render. Non-repos resolve to null → no badge, no Diff tab.
const gitStatus = new Map<string, GitStatusSummary>()
const gitDiff = new Map<string, GitDiff | null>()
const gitLoaded = new Set<string>()

/** Fetch a project's git status + working-tree diff once, then re-render. */
function loadGit(projectId: string) {
  if (gitLoaded.has(projectId)) return
  gitLoaded.add(projectId)
  window.agentIDE
    .gitStatus(projectId)
    .then((s) => {
      if (s && !('error' in s)) {
        gitStatus.set(projectId, s)
        render()
      }
    })
    .catch(() => {
      /* non-repo / git unavailable — leave badge empty */
    })
  window.agentIDE
    .gitDiff(projectId)
    .then((d) => {
      gitDiff.set(projectId, d && !('error' in d) ? d : null)
      render()
    })
    .catch(() => {
      gitDiff.set(projectId, null)
    })
}

/** Build the read-only Diff pane (plain <pre>, textContent only — no innerHTML,
 *  no mutation, no write buttons). Shows the stat summary then the bounded patch;
 *  a truncation notice when the diff exceeded the 512KB cap. */
function diffPaneFor(projectId: string): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'diff-pane'
  const d = gitDiff.get(projectId)
  const pre = document.createElement('pre')
  pre.className = 'diff-body'
  if (d === undefined) {
    pre.textContent = '› loading diff…'
  } else if (d === null) {
    pre.textContent = '› not a git repository'
  } else if (!d.stat.trim() && !d.patch.trim()) {
    pre.textContent = '› working tree clean — no changes'
  } else {
    const parts: string[] = []
    if (d.stat.trim()) parts.push(d.stat.trimEnd())
    if (d.patch) parts.push(d.patch)
    if (d.truncated) parts.push('\n… diff truncated at 512KB (read-only preview) …')
    pre.textContent = parts.join('\n')
  }
  wrap.appendChild(pre)
  return wrap
}

// ---- Explorer expansion + open file tabs (per current project) ----------------
// Expanded directory paths (project-relative) and a lazy cache of each dir's
// children. A dir present in `dirChildren` is loaded; absent + expanded = loading.
const expandedDirs = new Set<string>()
const dirChildren = new Map<string, FileNode[]>()

/** Fetch a directory's children once, then re-render. */
function loadDir(projectId: string, relPath: string) {
  if (dirChildren.has(relPath)) return
  window.agentIDE.fsDir(projectId, relPath).then((kids) => {
    dirChildren.set(relPath, kids.nodes as FileNode[])
    render()
  })
}

/** Toggle a folder open/closed; fetch children on first expand. */
function toggleDir(projectId: string, relPath: string) {
  if (expandedDirs.has(relPath)) {
    expandedDirs.delete(relPath)
  } else {
    expandedDirs.add(relPath)
    loadDir(projectId, relPath)
  }
  render()
}

// Open editor tabs and which tab is showing. activeTab defaults to the session.
const openFiles: OpenFile[] = []
const openReports: OpenReport[] = [] // F15: HTML reports rendered in-app
const fileContent = new Map<string, string>() // path -> on-disk/edited text
let activeTab: ActiveTab = { kind: 'session' }

/** F15: does this path look like an HTML report we should render in-app? */
function isHtml(relPath: string): boolean {
  return /\.html?$/i.test(relPath)
}

/** Open a project file in a tab (or focus it if already open). */
function openFile(projectId: string, relPath: string, name: string) {
  if (!openFiles.some((f) => f.path === relPath)) {
    openFiles.push({ path: relPath, name, dirty: false })
  }
  activeTab = { kind: 'file', path: relPath }
  render()
  if (!fileContent.has(relPath)) {
    window.agentIDE.fileRead(projectId, relPath).then((r) => {
      fileContent.set(relPath, r.error ? `‹ cannot open: ${r.error} ›` : (r.content ?? ''))
      render()
    })
  }
}

/** Close a file tab; fall back to the session tab if it was active. */
function closeFile(relPath: string) {
  const i = openFiles.findIndex((f) => f.path === relPath)
  if (i >= 0) openFiles.splice(i, 1)
  // Keep the cached text if the same path is also open as a rendered report.
  if (!openReports.some((r) => r.path === relPath)) fileContent.delete(relPath)
  if (activeTab.kind === 'file' && activeTab.path === relPath) {
    activeTab = openFiles.length
      ? { kind: 'file', path: openFiles[openFiles.length - 1].path }
      : { kind: 'session' }
  }
  render()
}

/** F15: open a project HTML file as a rendered report tab (or focus it if open).
 *  Reuses the same on-disk text cache as the editor — a report is just that text
 *  rendered in a sandboxed iframe rather than shown in a textarea. */
function openReport(projectId: string, relPath: string, name: string) {
  if (!openReports.some((r) => r.path === relPath)) {
    openReports.push({ path: relPath, name })
  }
  activeTab = { kind: 'report', path: relPath }
  render()
  if (!fileContent.has(relPath)) {
    window.agentIDE.fileRead(projectId, relPath).then((r) => {
      fileContent.set(relPath, r.error ? `‹ cannot open: ${r.error} ›` : (r.content ?? ''))
      render()
    })
  }
}

/** Close a report tab; fall back to the session tab if it was active. */
function closeReport(relPath: string) {
  const i = openReports.findIndex((r) => r.path === relPath)
  if (i >= 0) openReports.splice(i, 1)
  // Don't drop fileContent — the same path may still be open as an editor tab.
  if (!openFiles.some((f) => f.path === relPath)) fileContent.delete(relPath)
  if (activeTab.kind === 'report' && activeTab.path === relPath) {
    activeTab = openReports.length
      ? { kind: 'report', path: openReports[openReports.length - 1].path }
      : { kind: 'session' }
  }
  render()
}

/** Switch the open project, resetting per-project file/explorer state (open
 *  tabs, expansions and cached children are all project-relative and meaningless
 *  across projects). No-op if the project is unchanged (keeps tabs/expansions). */
function setCurrentProject(id: string) {
  if (state.currentProjectId === id) {
    state.view = 'cockpit'
    return
  }
  state.currentProjectId = id
  state.view = 'cockpit'
  openFiles.length = 0
  openReports.length = 0
  fileContent.clear()
  expandedDirs.clear()
  dirChildren.clear()
  activeTab = { kind: 'session' }
  backlogSelected.clear() // selection is per-project
}

/** Build the editable file pane for the active file tab (textarea + Ctrl+S save).
 *  Read-only here would be simpler, but the user asked for edit+save. */
function fileEditorFor(projectId: string, relPath: string): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'file-editor'

  const bar = document.createElement('div')
  bar.className = 'fe-bar'
  const path = document.createElement('span')
  path.className = 'fe-path'
  path.textContent = relPath
  const saveBtn = document.createElement('button')
  saveBtn.className = 'fe-save'
  const f = openFiles.find((x) => x.path === relPath)
  saveBtn.textContent = f?.dirty ? 'Save ⌘S' : 'Saved'
  saveBtn.disabled = !f?.dirty
  bar.append(path, saveBtn)
  wrap.appendChild(bar)

  const ta = document.createElement('textarea')
  ta.className = 'fe-area'
  ta.spellcheck = false
  ta.value = fileContent.get(relPath) ?? '…'
  wrap.appendChild(ta)

  const save = () => {
    const cur = openFiles.find((x) => x.path === relPath)
    if (!cur || !cur.dirty) return
    const text = ta.value
    window.agentIDE.fileWrite(projectId, relPath, text).then((r) => {
      if (r.ok) {
        fileContent.set(relPath, text)
        cur.dirty = false
        render()
      } else {
        // surface failure inline without losing edits
        path.textContent = `${relPath} — save failed: ${r.error}`
      }
    })
  }

  ta.addEventListener('input', () => {
    const cur = openFiles.find((x) => x.path === relPath)
    if (!cur) return
    const onDisk = fileContent.get(relPath) ?? ''
    const nowDirty = ta.value !== onDisk
    if (nowDirty !== cur.dirty) {
      cur.dirty = nowDirty
      saveBtn.textContent = nowDirty ? 'Save ⌘S' : 'Saved'
      saveBtn.disabled = !nowDirty
      // refresh the tab's dirty marker
      render()
    }
  })
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault()
      save()
    }
  })
  saveBtn.onclick = save

  // Keep focus + caret usable after a re-render by focusing on mount.
  queueMicrotask(() => ta.focus())
  return wrap
}

/** F15: render an HTML report file in a sandboxed iframe. The report runs with
 *  `sandbox` (no same-origin, no scripts-to-parent) so it cannot reach the app's
 *  DOM or state; `srcdoc` carries the file text. Self-contained reports
 *  (Playwright/coverage/Vitest) render fully; reports relying on sibling asset
 *  files won't resolve those under srcdoc — acceptable for v1 (see spec F15). */
function reportViewerFor(relPath: string): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'report-viewer'

  const bar = document.createElement('div')
  bar.className = 'rv-bar'
  const path = document.createElement('span')
  path.className = 'rv-path'
  path.textContent = relPath
  bar.appendChild(path)
  wrap.appendChild(bar)

  const frame = document.createElement('iframe')
  frame.className = 'rv-frame'
  // allow-scripts so charts/interactive reports work; NO allow-same-origin, so
  // the iframe stays in a null origin and can't touch the parent (the two
  // together would defeat the sandbox).
  frame.setAttribute('sandbox', 'allow-scripts')
  const html = fileContent.get(relPath)
  frame.srcdoc =
    html ?? '<!doctype html><body style="font:13px sans-serif;color:#888;padding:16px">Loading report…</body>'
  wrap.appendChild(frame)

  return wrap
}

// F14: reflect the REAL container status (queries Docker) once per project, so
// the button shows "running" if a container is already up from a previous run.
const containerStatusLoaded = new Set<string>()
function loadContainerStatus(projectId: string, localPath: string) {
  if (containerStatusLoaded.has(projectId)) return
  containerStatusLoaded.add(projectId)
  window.agentIDE.containerStatus(projectId, localPath).then((s) => {
    // s is 'running' | 'stopped' | 'none'. Reflect it on the button.
    if (containerState.get(projectId) !== s) {
      containerState.set(projectId, s)
      if (s === 'running') runInContainer.set(projectId, true) // running implies container mode
      render()
    }
  })
}

function addProjectToState(proj: Project) {
  if (!state.projects.find((p) => p.id === proj.id)) state.projects.push(proj)
  setCurrentProject(proj.id)
  render()
}

// F2: add-project menu — three ways, each picking a directory where needed.
function openAddProjectMenu(x: number, y: number) {
  showMenu(x, y, [
    {
      label: '📂 Open existing folder…',
      onClick: async () => {
        const dir = await window.agentIDE.openDirectory()
        if (dir) addProjectToState(await window.agentIDE.projectsAddLocal(dir))
      }
    },
    {
      label: '🐙 Clone from GitHub…',
      onClick: () => openGithubClone()
    },
    {
      label: '🔗 Clone from git URL…',
      onClick: async () => {
        const url = await promptText('Clone from git URL', 'https://github.com/owner/repo.git')
        if (!url) return
        const dir = await window.agentIDE.openDirectory()
        if (dir) addProjectToState(await window.agentIDE.projectsAddUrl(url, dir))
      }
    }
  ])
}

function openGithubClone() {
  window.agentIDE.githubRepos().then((repos) => {
    const picker = RepoPicker({
      repos,
      onPick: async (repo) => {
        closeOverlay()
        const dir = await window.agentIDE.openDirectory() // choose where to clone (item 2)
        if (!dir) return
        try {
          addProjectToState(await window.agentIDE.projectsAddGithub(repo, dir))
        } catch (err) {
          console.error('clone failed', err)
        }
      },
      onCancel: closeOverlay
    })
    picker.id = 'picker-overlay'
    document.body.appendChild(picker)
  })
}
function closeOverlay() {
  document.getElementById('picker-overlay')?.remove()
}

// ---- ⌘K / Ctrl+K search overlay (S7) -----------------------------------------
function closeSearch() {
  document.getElementById('search-overlay')?.remove()
}

/** Enter on a transcript hit: switch to the hit's project and activate the
 *  session (the same navigation the home board's onOpen performs). */
function selectSearchTranscript(projectId: string, sessionId: string) {
  setCurrentProject(projectId)
  state.activeSessionId = sessionId
  state.view = 'cockpit'
  render()
}

/** Enter on a backlog hit: open the Backlog view focused on that item. The
 *  Backlog view itself ships in S1; here we route to it (project + focus) so the
 *  seam is exercised and navigation is observable. */
function selectSearchBacklog(projectId: string, itemId: string) {
  setCurrentProject(projectId)
  state.view = 'backlog'
  state.backlogFocus = itemId
  render()
}

function openSearch() {
  if (document.getElementById('search-overlay')) return // already open
  const overlay = SearchOverlay({
    searchQuery: (q, limit) => window.agentIDE.searchQuery(q, limit),
    onSelectTranscript: selectSearchTranscript,
    onSelectBacklog: selectSearchBacklog,
    onClose: closeSearch
  })
  overlay.id = 'search-overlay'
  document.body.appendChild(overlay)
}

// Global ⌘K (macOS) / Ctrl+K (elsewhere) toggles the search overlay. Registered
// once at module load; the overlay owns its own Escape/close handling.
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault()
    if (document.getElementById('search-overlay')) closeSearch()
    else openSearch()
  }
})

// The session id we can write into right now (focused + has a live pty this run).
function activeLivePtyId(): string | null {
  const id = state.activeSessionId
  return id && launchedSessions.has(id) ? id : null
}

/** Strip a leading YAML frontmatter block from a markdown body (prompt text). */
function stripFrontmatter(text: string): string {
  const m = /^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  return (m ? m[1] : text).trim()
}

// D14: open a library category in a filterable panel.
function openLibrary(category: LibraryCategory) {
  if (!library) return
  const items = library[category]
  const panel = LibraryPanel({
    category,
    items,
    hasActiveSession: activeLivePtyId() !== null,
    onUse: (item) => {
      void useLibraryItem(item)
      closeOverlay()
    },
    // S8: launch a new session preset from an agent item.
    onLaunchAgent:
      category === 'agents'
        ? (item) => {
            closeOverlay()
            void launchAgentFlow(item)
          }
        : undefined,
    onAdd:
      category === 'agents'
        ? () => {
            closeOverlay()
            openAgentForm()
          }
        : undefined,
    onCancel: closeOverlay
  })
  panel.id = 'picker-overlay'
  document.body.appendChild(panel)
}

// S8: launch a session FROM a library agent. Opens the model picker prefilled
// with the agent's description as the objective (editable) and a switchable
// provider; on confirm, launches with the agent's relPath so main primes the
// agent body after the harness section and persists it for the session chip.
async function launchAgentFlow(agent: LibraryItem) {
  const proj = currentProject()
  if (!proj) return
  const ctx = await resolveRunContext(proj) // F11/F12
  if (ctx === null) return // cancelled
  const label = await chooseTaskLabel() // M-LOG-a
  if (label === null) return // cancelled
  const picker = ModelPicker({
    provider: 'claude',
    models: modelsFor('claude'),
    modelsForProvider: (prov) => modelsFor(prov),
    agentName: agent.name,
    objective: agent.description || agent.name,
    onLaunch: async (prov, modelId, objective) => {
      closeOverlay()
      try {
        const session = await window.agentIDE.sessionLaunch({
          projectId: proj.id,
          provider: prov,
          model: modelId,
          objective: objective || agent.name,
          cwd: proj.localPath,
          useContainer: ctx.useContainer,
          importConfig: ctx.importConfig,
          taskKind: label.taskKind,
          taskSubkind: label.taskSubkind,
          agentRelPath: agent.relPath
        })
        launchedSessions.add(session.id)
        state.sessions.push(session)
        state.activeSessionId = session.id
        state.view = 'cockpit'
        render()
      } catch (err) {
        console.error('agent-preset launch failed', err)
      }
    },
    onPick: () => {
      /* unused: onLaunch takes precedence */
    },
    onCancel: closeOverlay
  })
  picker.id = 'picker-overlay'
  document.body.appendChild(picker)
}

// B2: create a library agent via the modal form; refresh pills on success.
function openAgentForm() {
  const form = AgentForm({
    onSubmit: (input) => window.agentIDE.libraryAddAgent(input),
    onDone: () => {
      closeOverlay()
      loadLibrary()
      flash('agent added to the library')
    },
    onCancel: closeOverlay
  })
  form.id = 'picker-overlay'
  document.body.appendChild(form)
}

// S2: open the Linear integration panel for the current project. Link/pull/
// write-back are wired to the frozen linear:* bridge; the panel renders all
// Linear-sourced text via textContent only.
async function openLinear() {
  const proj = currentProject()
  if (!proj) return
  const status = (await window.agentIDE
    .linearStatus(proj.id)
    .catch(() => ({ connected: false }))) as LinearStatus
  const backlog = await window.agentIDE.backlogList(proj.id).catch(() => [])
  const rows: LinearBacklogRow[] = (
    backlog as Array<{
      id: string
      title: string
      source: string
      remoteStatus?: string | null
      linearUrl?: string | null
    }>
  )
    .filter((i) => i.source === 'linear')
    .map((i) => ({ id: i.id, title: i.title, remoteStatus: i.remoteStatus, linearUrl: i.linearUrl }))

  const panel = LinearPanel({
    status,
    rows,
    onLink: async () => {
      const label = await promptText('Team or project label (optional)', proj.name)
      const r = await window.agentIDE.linearLink(proj.id, { label: label ?? proj.name })
      if ((r as { error?: string }).error) flash(`Linear link failed: ${(r as { error?: string }).error}`)
      else {
        flash('Linear linked')
        closeOverlay()
        openLinear()
      }
    },
    onPull: async () => {
      const r = (await window.agentIDE.linearPull(proj.id)) as { ok?: true; count?: number; error?: string }
      if (r.error) flash(`Pull failed: ${r.error}`)
      else {
        flash(`Pulled ${r.count ?? 0} issue(s)`)
        loadLibrary()
        closeOverlay()
        openLinear()
      }
    },
    onLogout: async (accountId) => {
      const r = (await window.agentIDE.linearLogout(accountId)) as { ok?: true; error?: string }
      if (r.error) flash(`Logout failed: ${r.error}`)
      else {
        flash('Disconnected from Linear')
        closeOverlay()
        openLinear()
      }
    },
    onPreview: (itemId, action) =>
      window.agentIDE.linearWriteback(itemId, {
        ...action,
        mode: 'preview',
        sessionId: state.activeSessionId ?? 'no-session'
      }) as Promise<WritebackPreview | { error: string }>,
    onApply: (itemId, action) =>
      window.agentIDE.linearWriteback(itemId, {
        ...action,
        mode: 'apply',
        sessionId: state.activeSessionId ?? 'no-session'
      }) as Promise<{ ok?: boolean; outcome?: string; error?: string }>,
    onCancel: closeOverlay
  })
  panel.id = 'picker-overlay'
  document.body.appendChild(panel)
}

// S2: Cmd/Ctrl+L opens the Linear panel for the current project.
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'l' || e.key === 'L') && currentProject()) {
    e.preventDefault()
    if (document.getElementById('picker-overlay')) return
    void openLinear()
  }
})

// ---- S1 Backlog: create/edit modal + CRUD + selection --------------------------
function openBacklogModal(projectId: string, item?: BacklogItem) {
  const items = backlogItems.get(projectId) ?? []
  const modal = BacklogModal({
    item,
    items,
    onCreate: async (input: BacklogCreateInput) => {
      const r = await window.agentIDE.backlogCreate({ ...input, projectId })
      if (r.error) {
        flash(r.error)
        return
      }
      closeOverlay()
      loadBacklog(projectId, true)
    },
    onUpdate: async (input: BacklogUpdateInput) => {
      const r = await window.agentIDE.backlogUpdate(input)
      if (r.error) {
        flash(r.error)
        return
      }
      closeOverlay()
      loadBacklog(projectId, true)
    },
    onCancel: closeOverlay
  })
  modal.id = 'picker-overlay'
  document.body.appendChild(modal)
}

async function deleteBacklogItem(projectId: string, item: BacklogItem) {
  const ok = await chooseOption<'yes'>(`Delete “${item.title}”?`, [
    {
      label: 'Delete',
      value: 'yes',
      primary: true,
      hint: 'Children re-parent; a bound active session blocks deletion'
    }
  ])
  if (!ok) return
  const r = await window.agentIDE.backlogDelete(item.id)
  if (r.error) {
    flash(r.error)
    return
  }
  backlogSelected.delete(item.id)
  loadBacklog(projectId, true)
}

async function setBacklogStatus(projectId: string, item: BacklogItem, status: BacklogManualStatus) {
  const r = await window.agentIDE.backlogUpdate({ id: item.id, manualStatus: status })
  if (r.error) {
    flash(r.error)
    return
  }
  loadBacklog(projectId, true)
}

// "Work on this": pick a provider, then launch a session seeded with the selected
// backlog items (passed through as backlogItemIds → main binds them).
async function startWorkOnThis() {
  if (backlogSelected.size === 0) return
  const choice = await chooseOption<Provider>('Launch a session for the selected items', [
    { label: 'Codex', value: 'codex', primary: true },
    { label: 'Claude', value: 'claude' },
    { label: 'Gemini', value: 'gemini' }
  ])
  if (!choice) return
  await launchFlow(choice.value, [...backlogSelected])
}

/** Write library text into a session. Multi-line bodies go ONLY to provider
 *  sessions (a plain shell would EXECUTE each line), wrapped in bracketed-paste
 *  markers so the CLI treats them as one paste — never auto-submitted. */
function insertIntoSession(sessionId: string, text: string): void {
  if (!/[\r\n]/.test(text.trim())) {
    window.agentIDE.ptyWrite(sessionId, text)
    return
  }
  const isProviderSession = !sessionId.startsWith('term-') && !sessionId.startsWith('login-')
  if (!isProviderSession) {
    flash('multi-line items can only be inserted into an agent session, not a plain terminal')
    return
  }
  window.agentIDE.ptyWrite(sessionId, `\x1b[200~${text}\x1b[201~`)
}

// Insert a library item into the active session's pty. Prompts/Agents → the
// item body (frontmatter stripped). Skills/Workflows → an invocation hint the
// agent CLI understands (the item is in the mounted library, so the CLI can
// run it).
async function useLibraryItem(item: LibraryItem) {
  const sessionId = activeLivePtyId()
  if (!sessionId) return
  if (item.category === 'prompts' || item.category === 'agents') {
    const r = await window.agentIDE.libraryRead(item.relPath)
    if (r.content) insertIntoSession(sessionId, stripFrontmatter(r.content))
  } else if (item.category === 'skills') {
    // Skills are invoked by name in the CLIs (e.g. a /name command).
    window.agentIDE.ptyWrite(sessionId, `/${item.name} `)
  } else {
    // Workflow: drop a reference the agent can act on (it can read the file from
    // the mounted library). Keep it as plain text, no auto-submit.
    window.agentIDE.ptyWrite(
      sessionId,
      `Run the workflow "${item.name}" (library/workflows/${item.name}.js). `
    )
  }
}

// F11/F12: decide run context for a devcontainer project. Returns
// { useContainer, importConfig } or null if cancelled. Remembers per project.
async function resolveRunContext(
  proj: Project
): Promise<{ useContainer: boolean; importConfig: boolean } | null> {
  if (!proj.hasDevcontainer) return { useContainer: false, importConfig: false }
  if (runInContainer.has(proj.id)) {
    return { useContainer: runInContainer.get(proj.id)!, importConfig: false }
  }
  const choice = await chooseOption<'container' | 'host'>(
    `Run “${proj.name}” in its devcontainer?`,
    [
      { label: 'Run on host', value: 'host', hint: 'Full filesystem access, no container' },
      {
        label: 'Run in container',
        value: 'container',
        primary: true,
        hint: 'Isolated to the devcontainer workspace'
      }
    ],
    { label: 'Also import my ~/.claude skills + config into the container (read-only)', checked: true }
  )
  if (!choice) return null
  const useContainer = choice.value === 'container'
  runInContainer.set(proj.id, useContainer)
  return { useContainer, importConfig: useContainer && choice.checked }
}

// M-LOG-a (§4.5.1): "What is this chat for?" — every agent session is a labeled
// task. Product chats (code/feature/bug) get logged; analysis chats don't.
// Returns { taskKind, taskSubkind } or null if cancelled.
async function chooseTaskLabel(): Promise<{ taskKind: TaskKind; taskSubkind?: TaskSubkind } | null> {
  const kind = await chooseOption<TaskKind>('What is this chat for?', [
    {
      label: 'Product — build/change the code',
      value: 'product',
      primary: true,
      hint: 'Logged as a task; can become a roadmap ticket'
    },
    {
      label: 'Analysis — explore / ask / understand',
      value: 'analysis',
      hint: 'Saved and replayable, but not logged'
    }
  ])
  if (!kind) return null
  if (kind.value === 'analysis') return { taskKind: 'analysis' }
  const sub = await chooseOption<TaskSubkind>('What kind of product work?', [
    { label: 'Feature — new functionality', value: 'feature', primary: true },
    { label: 'Bug — fix a defect', value: 'bug' },
    { label: 'Code — refactor / chore / infra', value: 'code' }
  ])
  if (!sub) return null
  return { taskKind: 'product', taskSubkind: sub.value }
}

// F3: launch a session — choose run context, prompt for a name, label the task,
// then pick a model. S1: an optional backlog selection is carried through as
// backlogItemIds (bound to the new session; item → 'in-session').
async function launchFlow(provider: Provider, backlogItemIds: string[] = []) {
  const proj = currentProject()
  if (!proj) return
  if (backlogItemIds.length > 5) {
    flash('at most 5 backlog items per launch')
    return
  }
  const ctx = await resolveRunContext(proj) // F11/F12
  if (ctx === null) return // cancelled
  const name = await promptText(`Name this ${provider} session`, 'e.g. fix auth bug')
  if (name === null) return // cancelled
  const label = await chooseTaskLabel() // M-LOG-a
  if (label === null) return // cancelled
  const picker = ModelPicker({
    provider,
    models: modelsFor(provider),
    onPick: async (prov, modelId) => {
      closeOverlay()
      try {
        // S1: backlogItemIds rides along the launch payload (main binds it to the
        // new session). The frozen bridge type omits the field, so widen the arg.
        const req = {
          projectId: proj.id,
          provider: prov,
          model: modelId,
          objective: name || `${prov} session`,
          cwd: proj.localPath,
          useContainer: ctx.useContainer,
          importConfig: ctx.importConfig,
          taskKind: label.taskKind,
          taskSubkind: label.taskSubkind,
          backlogItemIds
        }
        const session = await window.agentIDE.sessionLaunch(
          req as unknown as Parameters<typeof window.agentIDE.sessionLaunch>[0]
        )
        launchedSessions.add(session.id)
        state.sessions.push(session)
        state.activeSessionId = session.id
        if (backlogItemIds.length) {
          backlogSelected.clear()
          loadBacklog(proj.id, true)
        }
        state.view = 'cockpit'
        render()
      } catch (err) {
        console.error('session launch failed', err)
      }
    },
    onCancel: closeOverlay
  })
  picker.id = 'picker-overlay'
  // S1: show the selected backlog items as chips at the top of the launcher.
  if (backlogItemIds.length) {
    const items = backlogItems.get(proj.id) ?? []
    const strip = document.createElement('div')
    strip.className = 'bk-launch-chips'
    const lbl = document.createElement('span')
    lbl.className = 'bk-launch-label'
    lbl.textContent = 'Working on:'
    strip.appendChild(lbl)
    for (const id of backlogItemIds) {
      const it = items.find((x) => x.id === id)
      const chip = document.createElement('span')
      chip.className = 'bk-launch-chip'
      chip.textContent = it ? it.title : id
      strip.appendChild(chip)
    }
    const modalEl = picker.querySelector('.modal')
    if (modalEl) modalEl.insertBefore(strip, modalEl.firstChild?.nextSibling ?? null)
  }
  document.body.appendChild(picker)
}

// F14: explicitly start the project's devcontainer (warm it before sessions).
async function startContainer() {
  const proj = currentProject()
  if (!proj || !proj.hasDevcontainer) return
  containerState.set(proj.id, 'starting')
  // First time? offer the config-import choice; else just start.
  let importConfig = false
  if (!runInContainer.has(proj.id)) {
    const choice = await chooseOption<'go'>(
      `Start “${proj.name}”'s container?`,
      [{ label: 'Start', value: 'go', primary: true }],
      { label: 'Import my ~/.claude skills + config (read-only)', checked: true }
    )
    if (!choice) {
      containerStatusLoaded.delete(proj.id)
      loadContainerStatus(proj.id, proj.localPath)
      return
    }
    importConfig = choice.checked
    runInContainer.set(proj.id, true) // starting the container implies container mode
  }
  render()
  try {
    await window.agentIDE.containerStart(proj.id, proj.localPath, importConfig)
  } catch (err) {
    console.error('start container failed', err)
    containerState.set(proj.id, 'error')
    render()
  }
}

// Stop the project's running container (reversible). Warns first if any of this
// project's sessions are running inside it — stopping kills their ptys (they flip
// to reconnectable, history kept). On confirm, docker stops it; the button then
// shows "Restart container".
async function stopContainer() {
  const proj = currentProject()
  if (!proj) return
  // Sessions live in THIS project's container only when it's in container mode.
  const inContainer = runInContainer.get(proj.id) ?? false
  const running = inContainer
    ? state.sessions.filter((s) => s.projectId === proj.id && s.status === 'running' && !reconnect.has(s.id))
    : []
  if (running.length > 0) {
    const ok = await chooseOption<'stop'>(
      `Stop “${proj.name}”'s container?`,
      [{ label: 'Stop anyway', value: 'stop', primary: true }],
      undefined,
      `${running.length} running session${running.length > 1 ? 's' : ''} will disconnect (history is kept; reconnect after restart).`
    )
    if (!ok) return
  }
  const prev = containerState.get(proj.id)
  containerState.set(proj.id, 'stopped') // optimistic; main confirms via container:status
  render()
  try {
    await window.agentIDE.containerStop(proj.id, proj.localPath)
  } catch (err) {
    console.error('stop container failed', err)
    containerState.set(proj.id, prev ?? 'running')
    render()
  }
}

// F13: open a plain shell session instantly (Terminal tab). Uses the project's
// remembered run-context (host/container); defaults to host if not yet chosen.
let termCount = 0
async function openTerminal() {
  const proj = currentProject()
  if (!proj) return
  termCount += 1
  try {
    const session = await window.agentIDE.terminalOpen({
      projectId: proj.id,
      cwd: proj.localPath,
      name: termCount === 1 ? 'terminal' : `terminal-${termCount}`,
      useContainer: runInContainer.get(proj.id) ?? false
    })
    launchedSessions.add(session.id)
    state.sessions.push(session)
    state.activeSessionId = session.id
    state.view = 'cockpit'
    render()
  } catch (err) {
    console.error('open terminal failed', err)
  }
}

// F8/F9: provider-tag menu — check health, run login, install CLI (with confirm).
async function refreshHealth(provider: Provider) {
  const proj = currentProject()
  if (!proj) return
  try {
    // Health in the project's SELECTED context (B5): host-mode users must not
    // see the container's health just because one happens to be running.
    health[provider] = await window.agentIDE.providerHealth(
      provider,
      proj.id,
      proj.localPath,
      runInContainer.get(proj.id)
    )
    render()
  } catch (err) {
    console.error('health check failed', err)
  }
}

function openProviderMenu(provider: Provider, x: number, y: number) {
  const proj = currentProject()
  if (!proj) return
  const h = health[provider]
  const items: { label: string; danger?: boolean; onClick: () => void }[] = [
    { label: '🔍 Check connection health', onClick: () => void refreshHealth(provider) }
  ]
  // Login only makes sense when the CLI exists (or state unknown) — not when missing.
  if (h !== 'not-installed') {
    items.push({
      label: '🔑 Run CLI login',
      onClick: () => {
        window.agentIDE.providerLogin(provider, proj.id, proj.localPath).then((id) => {
          // surface the login as the active terminal session
          launchedSessions.add(id)
          state.sessions.push({
            id,
            projectId: proj.id,
            provider,
            model: 'login',
            objective: `${provider} login`,
            status: 'running',
            createdAt: 0,
            updatedAt: 0
          })
          state.activeSessionId = id
          state.view = 'cockpit'
          render()
        })
      }
    })
  }
  // Install only when the CLI is missing inside a running container — with confirm.
  if (h === 'not-installed' && runInContainer.get(proj.id)) {
    items.push({
      label: `⬇ Install ${provider} CLI in container…`,
      onClick: async () => {
        const ok = await chooseOption<'yes'>(
          `Install the ${provider} CLI inside “${proj.name}”'s container?`,
          [{ label: 'Install', value: 'yes', primary: true }]
        )
        if (!ok) return
        try {
          health[provider] = await window.agentIDE.providerInstall(provider, proj.id, proj.localPath)
          render()
        } catch (err) {
          console.error('install failed', err)
        }
      }
    })
  }
  showMenu(x, y, items)
}

// F7: reconnect a crashed session via the existing resume path. Drops the stale
// terminal so it rebuilds attach-only against the freshly-spawned pty; the
// resumed CLI re-renders its conversation (history is preserved in the store).
async function reconnectSession(session: Session) {
  const proj = state.projects.find((p) => p.id === session.projectId)
  const cwd = proj?.localPath ?? ''
  // Resume in the SAME context the session ran in: the session's persisted
  // context (B6) survives restarts; the per-project map is only a fallback.
  const useContainer = session.useContainer ?? runInContainer.get(session.projectId) ?? false
  try {
    disposeTerminal(session.id) // discard dead-pty terminal + its listener
    const resumed = await window.agentIDE.sessionResume(session, cwd, useContainer)
    launchedSessions.add(session.id) // rebuilt terminal attaches to the new pty
    session.status = resumed.status
    reconnect.delete(session.id)
    state.activeSessionId = session.id
    render()
  } catch (err) {
    console.error('reconnect failed', err)
  }
}

// Move a session's conversation to a different engine. Picks provider → model,
// then relaunches the same session id under that engine; main seeds it with the
// session's stored history so the conversation continues. The terminal rebuilds
// attach-only against the freshly-spawned pty.
async function changeModelFlow(session: Session) {
  const proj = state.projects.find((p) => p.id === session.projectId)
  if (!proj) return
  const provChoice = await chooseOption<Provider>(
    'Change model — pick an engine',
    (['claude', 'codex', 'gemini'] as Provider[]).map((p) => ({ label: p, value: p }))
  )
  if (!provChoice) return
  const provider = provChoice.value
  const modelChoice = await chooseOption<string>(
    `Pick a ${provider} model`,
    modelsFor(provider).map((m) => ({ label: m.label, value: m.id }))
  )
  if (!modelChoice) return
  const useContainer = runInContainer.get(session.projectId) ?? false
  try {
    disposeTerminal(session.id) // old engine's terminal is stale; rebuild on the new pty
    const updated = await window.agentIDE.sessionChangeModel(
      session,
      proj.localPath,
      useContainer,
      provider,
      modelChoice.value
    )
    launchedSessions.add(session.id)
    session.provider = updated.provider
    session.model = updated.model
    session.status = updated.status
    reconnect.delete(session.id)
    state.activeSessionId = session.id
    render()
  } catch (err) {
    console.error('change model failed', err)
  }
}

// S3: advance a session's stage (adjacent-only: discussion→playback→fix) via the
// declarative session:setStage. Advancing to fix on a RUNNING CONTAINER session
// flips the spawn-baked approval mode, so the foundation relaunches the engine in
// fix mode — we confirm first ("Playback approved → restart engine in fix mode").
// Host sessions advance as pure labels (no confirm, no relaunch). Because the
// reconcile runs asynchronously under the per-project gate, we re-fetch sessions
// after the call so the chip reflects the applied effectiveStage.
async function advanceStage(session: Session, to: SessionStage) {
  try {
    const res = await runAdvanceFlow(session, to, {
      confirm: async (message) =>
        !!(await chooseOption<'yes'>(message, [
          { label: 'Restart in fix mode', value: 'yes', primary: true }
        ])),
      setStage: (id, stage) => window.agentIDE.sessionSetStage(id, stage)
    })
    if (res === null) return // user cancelled the fix-restart confirm
    if (res.error) {
      flash(res.error)
      return
    }
    await refreshSessions()
  } catch (err) {
    flash((err as Error).message)
  }
}

/** Re-hydrate sessions from the store (after a declarative stage/model write the
 *  reconcile settles asynchronously; this pulls the applied state back). */
async function refreshSessions() {
  try {
    const sessions = await window.agentIDE.sessionsAll()
    // Preserve local-only fields not on the persisted row would live here; the
    // store is the source of truth for stage/status/spawned* so replace wholesale.
    state.sessions = sessions
    render()
  } catch (err) {
    console.error('refresh sessions failed', err)
  }
}

// Permanently delete an archived session from the home board's Archived view.
// Confirms first (irreversible from the app), then removes it from the store +
// its on-disk history (moved to Bin/ per never-rm), and drops it from state.
async function deleteArchivedSession(session: Session) {
  const ok = await chooseOption<'delete'>(
    `Delete “${session.objective}”?`,
    [{ label: 'Delete', value: 'delete', primary: true }],
    undefined,
    "Removes this chat and its history permanently. This can't be undone."
  )
  if (!ok) return
  try {
    await window.agentIDE.sessionDelete(session.id)
    const i = state.sessions.findIndex((s) => s.id === session.id)
    if (i >= 0) state.sessions.splice(i, 1)
    disposeTerminal(session.id)
    reconnect.delete(session.id)
    if (state.activeSessionId === session.id) state.activeSessionId = null
    render()
  } catch (err) {
    console.error('delete session failed', err)
  }
}

// F6/F7: three-dot session menu — reconnect (if crashed), rename, change model, close+archive.
function openSessionMenu(session: Session, x: number, y: number) {
  const items = []
  if (reconnect.has(session.id)) {
    items.push({
      label: '↻ Reconnect',
      onClick: () => {
        void reconnectSession(session)
      }
    })
  }
  // M-LOG-a (§4.5.3): a product task can be marked finished, which exports its raw
  // log entry in main. Only shown for a product chat still 'open'.
  if (session.taskKind === 'product' && (session.taskStatus ?? 'open') === 'open') {
    items.push({
      label: '✓ Mark finished (export log)',
      onClick: async () => {
        const res = await window.agentIDE.taskSetStatus(session.id, 'finished')
        if (res.error) {
          console.error('mark finished failed', res.error)
          return
        }
        session.taskStatus = 'finished'
        render()
      }
    })
  }
  // M-LOG-b (§4.5.3): a finished/deployed product task can generate its roadmap
  // ticket via the headless addendum pass. On success the task becomes 'ticketed';
  // on failure it stays deployed (retry available).
  if (
    session.taskKind === 'product' &&
    (session.taskStatus === 'finished' || session.taskStatus === 'deployed')
  ) {
    items.push({
      label: '📋 Mark deployed → generate ticket',
      onClick: async () => {
        session.taskStatus = 'deployed'
        render()
        const res = await window.agentIDE.taskGenerateTicket(session.id)
        if (res.error) {
          console.error('ticket generation failed (stays deployed — retry):', res.error)
          await promptText('Ticket generation failed — retry available', res.error).catch(() => {})
          return
        }
        session.taskStatus = 'ticketed'
        render()
      }
    })
  }
  // S3: adjacent-only stage advance from the session menu (mirrors the header
  // control). Only for provider sessions that have a next stage.
  if (!isTerminalSession(session.id) && session.model !== 'login') {
    const to = nextStage(effectiveStageOf(session))
    if (to) {
      items.push({
        label: `⏭ Advance to ${to.charAt(0).toUpperCase() + to.slice(1)}`,
        onClick: () => {
          void advanceStage(session, to)
        }
      })
    }
  }
  items.push(
    {
      label: 'Rename…',
      onClick: async () => {
        const name = await promptText('Rename session', session.objective)
        if (name === null || name === '') return
        await window.agentIDE.sessionRename(session.id, name)
        session.objective = name
        render()
      }
    },
    {
      // Move this conversation to a different engine: the IDE relaunches the same
      // session under the chosen provider/model and seeds it with the prior
      // history, so the conversation carries over across models.
      label: '⇄ Change model…',
      onClick: () => {
        void changeModelFlow(session)
      }
    },
    {
      label: 'Close + Archive',
      danger: true,
      onClick: () => {
        window.agentIDE.sessionArchive(session.id) // kills pty + persists archived
        session.status = 'archived'
        reconnect.delete(session.id)
        disposeTerminal(session.id)
        if (state.activeSessionId === session.id) {
          // focus another live session in this project, if any
          const next = state.sessions.find(
            (s) => s.projectId === session.projectId && s.status !== 'archived' && s.id !== session.id
          )
          state.activeSessionId = next?.id ?? null
        }
        render()
      }
    }
  )
  showMenu(x, y, items)
}

// ---- S6: queue drawer -------------------------------------------------------
// Cache the current project's queue items; refreshed on open + on queue:changed.
const queueItems = new Map<string, QueueItem[]>()
const autoAdvanceByProject = new Map<string, boolean>()

async function openQueueDrawer() {
  const proj = currentProject()
  if (!proj) return
  const [items, auto] = await Promise.all([
    window.agentIDE.queueList(proj.id),
    window.agentIDE.queueGetAutoAdvance(proj.id)
  ])
  queueItems.set(proj.id, items)
  autoAdvanceByProject.set(proj.id, auto)
  mountQueueDrawer(proj.id)
}

function mountQueueDrawer(projectId: string) {
  closeOverlay()
  const proj = state.projects.find((p) => p.id === projectId)
  if (!proj) return
  const refresh = async () => {
    queueItems.set(projectId, await window.agentIDE.queueList(projectId))
    mountQueueDrawer(projectId)
  }
  const drawer = QueueDrawer({
    projectName: proj.name,
    items: queueItems.get(projectId) ?? [],
    autoAdvance: autoAdvanceByProject.get(projectId) ?? false,
    modelsFor,
    onEnqueue: async (input) => {
      const res = await window.agentIDE.queueEnqueue({ projectId, ...input })
      if (!res.error) await refresh()
      return res
    },
    onDelete: async (id) => {
      await window.agentIDE.queueDelete(id)
      await refresh()
    },
    onReorder: async (orderedIds) => {
      await window.agentIDE.queueReorder(projectId, orderedIds)
      await refresh()
    },
    onStartNext: async () => {
      const r = await window.agentIDE.queueStartNext(projectId)
      if (r.sessionId) {
        // A queued session launched — hydrate it into the cockpit list.
        const s = (await window.agentIDE.sessionsAll()).find((x) => x.id === r.sessionId)
        if (s) {
          launchedSessions.add(s.id)
          if (!state.sessions.find((x) => x.id === s.id)) state.sessions.push(s)
          state.activeSessionId = s.id
        }
      }
      await refresh()
    },
    onToggleAutoAdvance: async (on) => {
      await window.agentIDE.queueSetAutoAdvance(projectId, on)
      autoAdvanceByProject.set(projectId, on)
      await refresh()
    },
    onClose: () => {
      closeOverlay()
      render()
    }
  })
  drawer.id = 'picker-overlay'
  document.body.appendChild(drawer)
}

// ---- S6: split view + handoff ------------------------------------------------
/** Toggle two-pane split view. On first enable, seed the second pane with another
 *  live session in this project (if any) so both panes show a terminal. */
function toggleSplit() {
  splitOn = !splitOn
  if (splitOn && !secondSessionId) {
    const proj = currentProject()
    const other = proj
      ? liveSessionsFor(state.sessions, proj.id).find(
          (s) => s.id !== state.activeSessionId && launchedSessions.has(s.id)
        )
      : undefined
    secondSessionId = other?.id ?? null
  }
  render()
}

/** Hand the FOCUSED pane's session tail off to the OTHER pane as pending review
 *  (never auto-submitted). Warns first if the target is in fix mode. */
async function handoffFocused() {
  if (!splitOn || !secondSessionId) return
  const fromId = focusedPane === 'primary' ? state.activeSessionId : secondSessionId
  const toId = focusedPane === 'primary' ? secondSessionId : state.activeSessionId
  if (!fromId || !toId) return
  const res = await window.agentIDE.sessionHandoff(fromId, toId)
  if (res.error) {
    flash(`handoff failed: ${res.error}`)
    return
  }
  // Record fix-mode so the target pane's affordance can show the warning banner.
  refreshReview(toId, res.targetInFix === true)
  flash('handoff registered for review — insert it from the target pane when ready')
}

/** Bracket-paste a session's pending review material into its pty (never
 *  auto-submitted). */
async function insertReview(sessionId: string) {
  const res = await window.agentIDE.reviewInsert(sessionId)
  if (res.error) {
    flash(`insert failed: ${res.error}`)
    return
  }
  reviewPending.delete(sessionId)
  render()
}

/** Build the "Review & insert" affordance for a session pane, or null if nothing
 *  is pending for it. */
function reviewElFor(sessionId: string | null): HTMLElement | null {
  if (!sessionId) return null
  const pend = reviewPending.get(sessionId)
  if (!pend) return null
  return HandoffReview({
    count: pend.count,
    totalChars: pend.chars,
    inFix: pend.inFix,
    onInsert: () => void insertReview(sessionId)
  })
}

function render() {
  root.innerHTML = ''
  // Window drag strip: titleBarStyle 'hiddenInset' removes the native macOS
  // title bar, so the renderer must own the drag surface. Rendered before the
  // body on every view path (home board and project cockpit).
  const titlebar = document.createElement('div')
  titlebar.className = 'titlebar'
  const tbTitle = document.createElement('span')
  tbTitle.className = 'tb-title'
  tbTitle.textContent = "NACHO'S IDE"
  titlebar.appendChild(tbTitle)
  root.appendChild(titlebar)
  const body = document.createElement('div')
  body.className = 'ide-body'

  const rail = ProjectRail({
    projects: state.projects,
    activeId: state.currentProjectId,
    counts: liveCounts(state.sessions),
    gitStatus: Object.fromEntries(gitStatus),
    // S5: projects with a session needing input get an attention dot on the rail.
    attentionProjects: attentionProjectSet(),
    onSelect: (id) => {
      setCurrentProject(id)
      render()
    },
    onHome: () => {
      state.view = 'home'
      render()
    },
    onAdd: () => {
      const r = document.querySelector('.projrail .add')?.getBoundingClientRect()
      openAddProjectMenu(r ? r.right : 70, r ? r.top : 80)
    }
  })
  body.appendChild(rail)
  body.appendChild(activityBar())

  // Home board (NN4) — also the launch state when no project is open (F1).
  if (state.view === 'home' || !currentProject()) {
    const board = AllSessions({
      projects: state.projects,
      sessions: state.sessions,
      attention,
      costs,
      mode: boardMode,
      onSetMode: (m) => {
        boardMode = m
        render()
      },
      onOpen: (projectId, sessionId) => {
        setCurrentProject(projectId)
        state.activeSessionId = sessionId
        render()
      },
      // F1: prominent "Open project" CTA lives in the board header; anchor the
      // add-project menu to the button's rect (left/bottom), as before.
      onOpenProject: (anchor) => openAddProjectMenu(anchor.left, anchor.bottom),
      onSyncHistory: () => window.agentIDE.historySync(new Date().toISOString()),
      onDelete: deleteArchivedSession
    })
    body.appendChild(board)
    root.appendChild(body)
    appendStatusBar()
    return
  }

  // S1 Backlog tab — project-scoped bento⇄table view.
  if (state.view === 'backlog') {
    const bproj = currentProject()!
    loadBacklog(bproj.id)
    body.appendChild(
      BacklogView({
        projectName: bproj.name,
        items: backlogItems.get(bproj.id) ?? [],
        layout: backlogLayout(),
        selected: backlogSelected,
        onToggleLayout: setBacklogLayout,
        onNew: () => openBacklogModal(bproj.id),
        onEdit: (it) => openBacklogModal(bproj.id, it),
        onDelete: (it) => deleteBacklogItem(bproj.id, it),
        onSetStatus: (it, s) => setBacklogStatus(bproj.id, it, s),
        onToggleSelect: (it) => {
          if (backlogSelected.has(it.id)) backlogSelected.delete(it.id)
          else {
            if (backlogSelected.size >= 5) {
              flash('at most 5 backlog items per launch')
              return
            }
            backlogSelected.add(it.id)
          }
          render()
        },
        onWorkOnThis: () => startWorkOnThis(),
        // S7 ⌘K navigation target: the search overlay routes here with a focused
        // item id so the full Backlog view can highlight/scroll to it.
        focusId: state.backlogFocus ?? null
      })
    )
    root.appendChild(body)
    return
  }

  const proj = currentProject()!

  // The cockpit shows live sessions only; archived ones live on the ⌘ home board.
  const projectSessions = liveSessionsFor(state.sessions, proj.id)
  const activeSession = projectSessions.find((s) => s.id === state.activeSessionId) ?? null

  loadTree(proj.id)
  loadGit(proj.id) // S4: branch/dirty badge + working-tree diff (read-only)
  if (proj.hasDevcontainer) loadContainerStatus(proj.id, proj.localPath)
  body.appendChild(
    Explorer({
      projectName: proj.name,
      tree: trees.get(proj.id) ?? [],
      expanded: expandedDirs,
      childrenOf: (dirPath) => dirChildren.get(dirPath),
      activePath: activeTab.kind === 'file' || activeTab.kind === 'report' ? activeTab.path : undefined,
      onToggleDir: (dirPath) => toggleDir(proj.id, dirPath),
      // Left-click: .html renders in-app (F15), everything else opens the editor.
      onOpenFile: (filePath, name) =>
        isHtml(filePath) ? openReport(proj.id, filePath, name) : openFile(proj.id, filePath, name),
      // Right-click any file: offer "Open in new tab" → rendered report (F15).
      onContextMenu: (filePath, name, x, y) =>
        showMenu(x, y, [
          { label: 'Open in new tab', onClick: () => openReport(proj.id, filePath, name) },
          { label: 'Open in editor', onClick: () => openFile(proj.id, filePath, name) }
        ])
    })
  )
  // Only mount a live terminal for sessions launched this run; hydrated/stale
  // sessions have no pty and are shown as reconnectable instead.
  const terminalEl =
    activeSession && launchedSessions.has(activeSession.id) ? terminalFor(activeSession.id) : undefined
  const fileEl = activeTab.kind === 'file' ? fileEditorFor(proj.id, activeTab.path) : undefined
  const reportEl = activeTab.kind === 'report' ? reportViewerFor(activeTab.path) : undefined
  // S4: the Diff tab appears only for git repos (gitDiff resolved to a diff, not
  // null); its pane is built only when active. gitDiff===undefined = still loading
  // (repo status unknown) → show the tab optimistically so the user can open it.
  const isRepo = gitDiff.get(proj.id) !== null
  const diffEl = isRepo
    ? activeTab.kind === 'diff'
      ? diffPaneFor(proj.id)
      : document.createElement('div')
    : undefined

  // S6 split view: resolve the SECOND pane's session + terminal. If the remembered
  // second session is gone (archived/closed), drop it.
  if (secondSessionId && !projectSessions.some((s) => s.id === secondSessionId)) secondSessionId = null
  const secondSession = secondSessionId
    ? (projectSessions.find((s) => s.id === secondSessionId) ?? null)
    : null
  const secondTerminalEl =
    secondSession && launchedSessions.has(secondSession.id) ? terminalFor(secondSession.id) : undefined

  body.appendChild(
    SupervisionView({
      session: activeSession,
      projectName: proj.name,
      openFiles,
      openReports,
      activeTab,
      terminalEl,
      fileEl,
      reportEl,
      diffEl,
      reviewEl: reviewElFor(activeSession?.id ?? null),
      splitOn,
      secondPane: splitOn
        ? {
            session: secondSession,
            terminalEl: secondTerminalEl,
            reviewEl: reviewElFor(secondSession?.id ?? null),
            focused: focusedPane === 'second',
            onFocus: () => {
              focusedPane = 'second'
              render()
            }
          }
        : undefined,
      onToggleSplit: toggleSplit,
      onHandoff: () => void handoffFocused(),
      onFocusPrimary: () => {
        focusedPane = 'primary'
        render()
      },
      onSelectTab: (tab) => {
        activeTab = tab
        render()
      },
      onCloseFile: closeFile,
      onCloseReport: closeReport,
      agentName: activeSession ? agentNameFor(activeSession) : null,
      // S3: only provider sessions carry a stage; terminals/logins don't.
      onAdvanceStage:
        activeSession && !isTerminalSession(activeSession.id) && activeSession.model !== 'login'
          ? (session, to) => {
              void advanceStage(session, to)
            }
          : undefined
    })
  )
  body.appendChild(
    Cockpit({
      sessions: projectSessions,
      activeSessionId: state.activeSessionId,
      reconnect,
      health,
      attention,
      costs,
      libraryCounts: library
        ? {
            prompts: library.prompts.length,
            skills: library.skills.length,
            workflows: library.workflows.length,
            agents: library.agents.length
          }
        : undefined,
      onLibraryPill: openLibrary,
      onLaunch: launchFlow,
      onSelectSession: (id) => {
        state.activeSessionId = id
        render()
      },
      onSessionMenu: openSessionMenu,
      onProviderMenu: openProviderMenu,
      onOpenTerminal: openTerminal,
      showContainerButton: proj.hasDevcontainer,
      containerState: containerState.get(proj.id) ?? 'none',
      onStartContainer: startContainer,
      agentNameFor,
      onStopContainer: stopContainer
    })
  )

  root.appendChild(body)
  appendStatusBar()
}

// F16: the bottom status bar, appended after the main body on every render.
function appendStatusBar() {
  root.appendChild(
    StatusBar({
      status: serviceStatus,
      checking: serviceChecking,
      onRecheck: recheckService,
      onConnect: connectService
    })
  )
}

// F1: hydrate persisted projects/sessions from the store at boot.
async function boot() {
  try {
    const [projects, sessions] = await Promise.all([
      window.agentIDE.projectsList(),
      window.agentIDE.sessionsAll(),
      loadModels() // B13: fetch the model registry from main (single source)
    ])
    state.projects = projects
    state.sessions = sessions
    // Hydrated non-archived sessions: on macOS the window closes while sessions
    // keep running, so ask main which ptys are still LIVE — those get attached
    // (never respawned); only truly dead ones become reconnectable (Codex P2).
    const nonArchived = sessions.filter((s) => s.status !== 'archived')
    const alive = await Promise.all(nonArchived.map((s) => window.agentIDE.ptyAlive(s.id).catch(() => false)))
    nonArchived.forEach((s, i) => {
      if (alive[i]) launchedSessions.add(s.id)
      else reconnect.add(s.id)
    })
    // Seed each project's run-context from its most recent session's persisted
    // context (B6) so health checks and resumes start from the real mode.
    for (const s of [...sessions].sort((a, b) => a.updatedAt - b.updatedAt)) {
      if (typeof s.useContainer === 'boolean') runInContainer.set(s.projectId, s.useContainer)
    }
  } catch (err) {
    console.error('boot hydrate failed', err)
  }
  // S5: seed the attention map for sessions already flagged in main (re-open).
  window.agentIDE
    .attentionState?.()
    .then((m) => {
      for (const [id, st] of Object.entries(m)) attention.set(id, st)
      render()
    })
    .catch(() => {
      /* attention unavailable */
    })
  // S5: seed persisted cost summaries for live sessions so chips show on re-open.
  for (const s of state.sessions.filter((x) => x.status !== 'archived')) {
    window.agentIDE
      .costForSession(s.id)
      .then((c) => {
        if (c && !('error' in c)) {
          costs.set(s.id, c as CostSummary)
          render()
        }
      })
      .catch(() => {
        /* no cost */
      })
  }
  loadLibrary() // D14: populate library pill counts (async, re-renders on load)
  render()
  probeServices() // F16: test external-service connectivity on startup (async)
}

boot()
