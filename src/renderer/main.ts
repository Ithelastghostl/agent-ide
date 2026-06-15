import './cockpit.css'
import type { Provider, Project, Session } from '@shared/types'
import { initialState, liveCounts, liveSessionsFor, type AppState } from './state'
import { ProjectRail } from './components/ProjectRail'
import { Cockpit, type ProviderHealth } from './components/Cockpit'
import { SupervisionView } from './components/SupervisionView'
import { Explorer, type FileNode } from './components/Explorer'
import { ModelPicker } from './components/ModelPicker'
import { RepoPicker } from './components/RepoPicker'
import { SessionTerminal } from './components/SessionTerminal'
import { AllSessions } from './components/AllSessions'
import { modelsFor } from './models'
import { showMenu, promptText, chooseOption } from './ui'

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
const terminals = new Map<string, HTMLElement>()
const launchedSessions = new Set<string>()
function terminalFor(sessionId: string, cwd: string): HTMLElement {
  let el = terminals.get(sessionId)
  if (!el) {
    el = launchedSessions.has(sessionId)
      ? SessionTerminal(sessionId) // attach-only (pty spawned in main)
      : SessionTerminal(sessionId, { shell: 'bash', args: [], cwd, env: {} })
    terminals.set(sessionId, el)
  }
  return el
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
  const cog = document.createElement('div'); cog.className = 'ic'; cog.textContent = '⚙'; el.appendChild(cog)
  return el
}

function currentProject(): Project | null {
  return state.projects.find((p) => p.id === state.currentProjectId) ?? null
}

// File tree per project, loaded lazily from the real filesystem.
const trees = new Map<string, FileNode[]>()
function loadTree(projectId: string, localPath: string) {
  if (trees.has(projectId)) return
  trees.set(projectId, [])
  window.agentIDE.fsTree(localPath).then((t) => { trees.set(projectId, t as FileNode[]); render() })
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
  state.currentProjectId = proj.id
  state.view = 'cockpit'
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

// F3: launch a session — choose run context, prompt for a name, then pick a model.
async function launchFlow(provider: Provider) {
  const proj = currentProject()
  if (!proj) return
  const ctx = await resolveRunContext(proj) // F11/F12
  if (ctx === null) return // cancelled
  const name = await promptText(`Name this ${provider} session`, 'e.g. fix auth bug')
  if (name === null) return // cancelled
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
          importConfig: ctx.importConfig
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
    health[provider] = await window.agentIDE.providerHealth(provider, proj.id, proj.localPath)
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
  try {
    terminals.delete(session.id) // discard dead-pty terminal element
    const resumed = await window.agentIDE.sessionResume(session, cwd)
    launchedSessions.add(session.id) // rebuilt terminal attaches to the new pty
    session.status = resumed.status
    reconnect.delete(session.id)
    state.activeSessionId = session.id
    render()
  } catch (err) {
    console.error('reconnect failed', err)
  }
}

// F6/F7: three-dot session menu — reconnect (if crashed), rename, close+archive.
function openSessionMenu(session: Session, x: number, y: number) {
  const items = []
  if (reconnect.has(session.id)) {
    items.push({
      label: '↻ Reconnect',
      onClick: () => { void reconnectSession(session) }
    })
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
      label: 'Close + Archive',
      danger: true,
      onClick: () => {
        window.agentIDE.sessionArchive(session.id) // kills pty + persists archived
        session.status = 'archived'
        reconnect.delete(session.id)
        terminals.delete(session.id)
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
  const body = document.createElement('div')
  body.className = 'ide-body'

  const rail = ProjectRail({
    projects: state.projects,
    activeId: state.currentProjectId,
    counts: liveCounts(state.sessions),
    onSelect: (id) => { state.currentProjectId = id; state.view = 'cockpit'; render() },
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
        state.currentProjectId = projectId
        state.activeSessionId = sessionId
        state.view = 'cockpit'
        render()
      }
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

  loadTree(proj.id, proj.localPath)
  if (proj.hasDevcontainer) loadContainerStatus(proj.id, proj.localPath)
  body.appendChild(Explorer({ projectName: proj.name, tree: trees.get(proj.id) ?? [] }))
  const terminalEl = activeSession ? terminalFor(activeSession.id, proj.localPath) : undefined
  body.appendChild(SupervisionView({ session: activeSession, projectName: proj.name, terminalEl }))
  body.appendChild(
    Cockpit({
      sessions: projectSessions,
      activeSessionId: state.activeSessionId,
      reconnect,
      health,
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
      window.agentIDE.sessionsAll()
    ])
    state.projects = projects
    state.sessions = sessions
  } catch (err) {
    console.error('boot hydrate failed', err)
  }
  render()
}

boot()
