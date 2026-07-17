import './cockpit.css'
import { isTerminalSession } from '@shared/types'
import type { Provider, Project, Session, SessionStage, TaskKind, TaskSubkind } from '@shared/types'
import { initialState, liveCounts, liveSessionsFor, type AppState } from './state'
import { ProjectRail } from './components/ProjectRail'
import { Cockpit, type ProviderHealth } from './components/Cockpit'
import { SupervisionView, type OpenFile, type OpenReport, type ActiveTab } from './components/SupervisionView'
import { Explorer, type FileNode } from './components/Explorer'
import { ModelPicker } from './components/ModelPicker'
import { LibraryPanel } from './components/LibraryPanel'
import { AgentForm } from './components/AgentForm'
import type { LibraryCategory, LibraryContents, LibraryItem } from '@shared/types'
import { RepoPicker } from './components/RepoPicker'
import { SessionTerminal } from './components/SessionTerminal'
import { AllSessions } from './components/AllSessions'
import { runAdvanceFlow, nextStage, effectiveStageOf } from './components/StageChip'
import { openHarnessEditor } from './components/HarnessEditor'
import { modelsFor, loadModels } from './models'
import { showMenu, promptText, chooseOption, flash } from './ui'

const root = document.getElementById('app')!
const state: AppState = initialState()

// Sessions whose process died (F4). Cleared when reconnected/relaunched.
const reconnect = new Set<string>()
// Last-known provider connection health, per provider (F8/F9).
const health: Partial<Record<Provider, ProviderHealth>> = {}
// Remembered run-context choice per project (F11): true=container, false=host.
const runInContainer = new Map<string, boolean>()
// Container state per project (F14).
const containerState = new Map<string, 'none' | 'stopped' | 'starting' | 'running' | 'error'>()
window.agentIDE.onContainerStatus?.(({ projectId, state: s }) => {
  containerState.set(projectId, s)
  render()
})

// Library contents (D14), loaded once at boot; undefined → pills show "—".
let library: LibraryContents | undefined
function loadLibrary() {
  window.agentIDE.libraryList().then((lib) => { library = lib; render() }).catch(() => { /* library unavailable */ })
}

// App-level notices from main (container mount remediation, etc.).
window.agentIDE.onNotice?.(({ message }) => flash(message, 4200))

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
  for (const [icon, on] of [['🗂', true], ['🔍', false], ['⑂', false], ['▷', false]] as const) {
    const d = document.createElement('div')
    d.className = 'ic' + (on ? ' on' : '')
    d.textContent = icon
    el.appendChild(d)
  }
  const sp = document.createElement('div'); sp.className = 'sp'; el.appendChild(sp)
  // S3: harness editor — the uniform Discussion→Playback→Fix protocol. Reachable
  // from the settings cog (home + cockpit both render the activity bar).
  const harness = document.createElement('div')
  harness.className = 'ic'
  harness.textContent = '📜'
  harness.title = 'Edit session harness'
  harness.onclick = () => { void openHarnessEditor({ get: () => window.agentIDE.harnessGet(), set: (t) => window.agentIDE.harnessSet(t) }) }
  el.appendChild(harness)
  const cog = document.createElement('div'); cog.className = 'ic'; cog.textContent = '⚙'; el.appendChild(cog)
  return el
}

function currentProject(): Project | null {
  return state.projects.find((p) => p.id === state.currentProjectId) ?? null
}

// File tree per project, loaded lazily from the real filesystem.
const trees = new Map<string, FileNode[]>()
function loadTree(projectId: string) {
  if (trees.has(projectId)) return
  trees.set(projectId, [])
  window.agentIDE.fsTree(projectId).then((t) => { trees.set(projectId, t.nodes as FileNode[]); render() })
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
const openReports: OpenReport[] = []            // F15: HTML reports rendered in-app
const fileContent = new Map<string, string>()   // path -> on-disk/edited text
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
    activeTab = openFiles.length ? { kind: 'file', path: openFiles[openFiles.length - 1].path } : { kind: 'session' }
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
    activeTab = openReports.length ? { kind: 'report', path: openReports[openReports.length - 1].path } : { kind: 'session' }
  }
  render()
}

/** Switch the open project, resetting per-project file/explorer state (open
 *  tabs, expansions and cached children are all project-relative and meaningless
 *  across projects). No-op if the project is unchanged (keeps tabs/expansions). */
function setCurrentProject(id: string) {
  if (state.currentProjectId === id) { state.view = 'cockpit'; return }
  state.currentProjectId = id
  state.view = 'cockpit'
  openFiles.length = 0
  openReports.length = 0
  fileContent.clear()
  expandedDirs.clear()
  dirChildren.clear()
  activeTab = { kind: 'session' }
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
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); save() }
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
  frame.srcdoc = html ?? '<!doctype html><body style="font:13px sans-serif;color:#888;padding:16px">Loading report…</body>'
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
        try { addProjectToState(await window.agentIDE.projectsAddGithub(repo, dir)) }
        catch (err) { console.error('clone failed', err) }
      },
      onCancel: closeOverlay
    })
    picker.id = 'picker-overlay'
    document.body.appendChild(picker)
  })
}
function closeOverlay() { document.getElementById('picker-overlay')?.remove() }

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
    onUse: (item) => { void useLibraryItem(item); closeOverlay() },
    onAdd: category === 'agents' ? () => { closeOverlay(); openAgentForm() } : undefined,
    onCancel: closeOverlay
  })
  panel.id = 'picker-overlay'
  document.body.appendChild(panel)
}

// B2: create a library agent via the modal form; refresh pills on success.
function openAgentForm() {
  const form = AgentForm({
    onSubmit: (input) => window.agentIDE.libraryAddAgent(input),
    onDone: () => { closeOverlay(); loadLibrary(); flash('agent added to the library') },
    onCancel: closeOverlay
  })
  form.id = 'picker-overlay'
  document.body.appendChild(form)
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
    window.agentIDE.ptyWrite(sessionId, `Run the workflow "${item.name}" (library/workflows/${item.name}.js). `)
  }
}

// F11/F12: decide run context for a devcontainer project. Returns
// { useContainer, importConfig } or null if cancelled. Remembers per project.
async function resolveRunContext(proj: Project): Promise<{ useContainer: boolean; importConfig: boolean } | null> {
  if (!proj.hasDevcontainer) return { useContainer: false, importConfig: false }
  if (runInContainer.has(proj.id)) {
    return { useContainer: runInContainer.get(proj.id)!, importConfig: false }
  }
  const choice = await chooseOption<'container' | 'host'>(
    `Run “${proj.name}” in its devcontainer?`,
    [
      { label: 'Run on host', value: 'host', hint: 'Full filesystem access, no container' },
      { label: 'Run in container', value: 'container', primary: true, hint: 'Isolated to the devcontainer workspace' }
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
    { label: 'Product — build/change the code', value: 'product', primary: true, hint: 'Logged as a task; can become a roadmap ticket' },
    { label: 'Analysis — explore / ask / understand', value: 'analysis', hint: 'Saved and replayable, but not logged' }
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
// then pick a model.
async function launchFlow(provider: Provider) {
  const proj = currentProject()
  if (!proj) return
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
        const session = await window.agentIDE.sessionLaunch({
          projectId: proj.id,
          provider: prov,
          model: modelId,
          objective: name || `${prov} session`,
          cwd: proj.localPath,
          useContainer: ctx.useContainer,
          importConfig: ctx.importConfig,
          taskKind: label.taskKind,
          taskSubkind: label.taskSubkind
        })
        launchedSessions.add(session.id)
        state.sessions.push(session)
        state.activeSessionId = session.id
        state.view = 'cockpit'
        render()
      } catch (err) { console.error('session launch failed', err) }
    },
    onCancel: closeOverlay
  })
  picker.id = 'picker-overlay'
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
    if (!choice) { containerStatusLoaded.delete(proj.id); loadContainerStatus(proj.id, proj.localPath); return }
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
  } catch (err) { console.error('open terminal failed', err) }
}

// F8/F9: provider-tag menu — check health, run login, install CLI (with confirm).
async function refreshHealth(provider: Provider) {
  const proj = currentProject()
  if (!proj) return
  try {
    // Health in the project's SELECTED context (B5): host-mode users must not
    // see the container's health just because one happens to be running.
    health[provider] = await window.agentIDE.providerHealth(provider, proj.id, proj.localPath, runInContainer.get(proj.id))
    render()
  } catch (err) { console.error('health check failed', err) }
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
            id, projectId: proj.id, provider, model: 'login',
            objective: `${provider} login`, status: 'running', createdAt: 0, updatedAt: 0
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
        } catch (err) { console.error('install failed', err) }
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
    const updated = await window.agentIDE.sessionChangeModel(session, proj.localPath, useContainer, provider, modelChoice.value)
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
        !!(await chooseOption<'yes'>(message, [{ label: 'Restart in fix mode', value: 'yes', primary: true }])),
      setStage: (id, stage) => window.agentIDE.sessionSetStage(id, stage)
    })
    if (res === null) return // user cancelled the fix-restart confirm
    if (res.error) { flash(res.error); return }
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

// F6/F7: three-dot session menu — reconnect (if crashed), rename, change model, close+archive.
function openSessionMenu(session: Session, x: number, y: number) {
  const items = []
  if (reconnect.has(session.id)) {
    items.push({
      label: '↻ Reconnect',
      onClick: () => { void reconnectSession(session) }
    })
  }
  // M-LOG-a (§4.5.3): a product task can be marked finished, which exports its raw
  // log entry in main. Only shown for a product chat still 'open'.
  if (session.taskKind === 'product' && (session.taskStatus ?? 'open') === 'open') {
    items.push({
      label: '✓ Mark finished (export log)',
      onClick: async () => {
        const res = await window.agentIDE.taskSetStatus(session.id, 'finished')
        if (res.error) { console.error('mark finished failed', res.error); return }
        session.taskStatus = 'finished'
        render()
      }
    })
  }
  // M-LOG-b (§4.5.3): a finished/deployed product task can generate its roadmap
  // ticket via the headless addendum pass. On success the task becomes 'ticketed';
  // on failure it stays deployed (retry available).
  if (session.taskKind === 'product' && (session.taskStatus === 'finished' || session.taskStatus === 'deployed')) {
    items.push({
      label: '📋 Mark deployed → generate ticket',
      onClick: async () => {
        session.taskStatus = 'deployed'; render()
        const res = await window.agentIDE.taskGenerateTicket(session.id)
        if (res.error) {
          console.error('ticket generation failed (stays deployed — retry):', res.error)
          await promptText('Ticket generation failed — retry available', res.error).catch(() => {})
          return
        }
        session.taskStatus = 'ticketed'; render()
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
        onClick: () => { void advanceStage(session, to) }
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
      onClick: () => { void changeModelFlow(session) }
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
    onSelect: (id) => { setCurrentProject(id); render() },
    onHome: () => { state.view = 'home'; render() },
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
      onOpen: (projectId, sessionId) => {
        setCurrentProject(projectId)
        state.activeSessionId = sessionId
        render()
      },
      onSyncHistory: () => window.agentIDE.historySync(new Date().toISOString())
    })
    // F1: prominent "Open project" CTA at the top of the board
    const cta = document.createElement('button')
    cta.className = 'open-cta'
    cta.textContent = '+ Open project'
    cta.onclick = (e) => openAddProjectMenu((e.target as HTMLElement).getBoundingClientRect().left, (e.target as HTMLElement).getBoundingClientRect().bottom)
    board.insertBefore(cta, board.querySelector('.sub')!.nextSibling)
    body.appendChild(board)
    root.appendChild(body)
    return
  }

  const proj = currentProject()!
  // The cockpit shows live sessions only; archived ones live on the ⌘ home board.
  const projectSessions = liveSessionsFor(state.sessions, proj.id)
  const activeSession = projectSessions.find((s) => s.id === state.activeSessionId) ?? null

  loadTree(proj.id)
  if (proj.hasDevcontainer) loadContainerStatus(proj.id, proj.localPath)
  body.appendChild(Explorer({
    projectName: proj.name,
    tree: trees.get(proj.id) ?? [],
    expanded: expandedDirs,
    childrenOf: (dirPath) => dirChildren.get(dirPath),
    activePath: activeTab.kind === 'file' || activeTab.kind === 'report' ? activeTab.path : undefined,
    onToggleDir: (dirPath) => toggleDir(proj.id, dirPath),
    // Left-click: .html renders in-app (F15), everything else opens the editor.
    onOpenFile: (filePath, name) =>
      isHtml(filePath)
        ? openReport(proj.id, filePath, name)
        : openFile(proj.id, filePath, name),
    // Right-click any file: offer "Open in new tab" → rendered report (F15).
    onContextMenu: (filePath, name, x, y) =>
      showMenu(x, y, [
        { label: 'Open in new tab', onClick: () => openReport(proj.id, filePath, name) },
        { label: 'Open in editor', onClick: () => openFile(proj.id, filePath, name) }
      ])
  }))
  // Only mount a live terminal for sessions launched this run; hydrated/stale
  // sessions have no pty and are shown as reconnectable instead.
  const terminalEl = activeSession && launchedSessions.has(activeSession.id)
    ? terminalFor(activeSession.id)
    : undefined
  const fileEl = activeTab.kind === 'file' ? fileEditorFor(proj.id, activeTab.path) : undefined
  const reportEl = activeTab.kind === 'report' ? reportViewerFor(activeTab.path) : undefined
  body.appendChild(SupervisionView({
    session: activeSession,
    projectName: proj.name,
    openFiles,
    openReports,
    activeTab,
    terminalEl,
    fileEl,
    reportEl,
    onSelectTab: (tab) => { activeTab = tab; render() },
    onCloseFile: closeFile,
    onCloseReport: closeReport,
    // S3: only provider sessions carry a stage; terminals/logins don't.
    onAdvanceStage: activeSession && !isTerminalSession(activeSession.id) && activeSession.model !== 'login'
      ? (session, to) => { void advanceStage(session, to) }
      : undefined
  }))
  body.appendChild(
    Cockpit({
      sessions: projectSessions,
      activeSessionId: state.activeSessionId,
      reconnect,
      health,
      libraryCounts: library
        ? { prompts: library.prompts.length, skills: library.skills.length, workflows: library.workflows.length, agents: library.agents.length }
        : undefined,
      onLibraryPill: openLibrary,
      onLaunch: launchFlow,
      onSelectSession: (id) => { state.activeSessionId = id; render() },
      onSessionMenu: openSessionMenu,
      onProviderMenu: openProviderMenu,
      onOpenTerminal: openTerminal,
      showContainerButton: proj.hasDevcontainer,
      containerState: containerState.get(proj.id) ?? 'none',
      onStartContainer: startContainer
    })
  )

  root.appendChild(body)
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
  loadLibrary() // D14: populate library pill counts (async, re-renders on load)
  render()
}

boot()
