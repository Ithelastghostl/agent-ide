import './cockpit.css'
import type { Provider, Project, Session } from '@shared/types'
import { initialState, liveCounts, type AppState } from './state'
import { ProjectRail } from './components/ProjectRail'
import { Cockpit } from './components/Cockpit'
import { SupervisionView } from './components/SupervisionView'
import { Explorer, type FileNode } from './components/Explorer'
import { ModelPicker } from './components/ModelPicker'
import { RepoPicker } from './components/RepoPicker'
import { SessionTerminal } from './components/SessionTerminal'
import { AllSessions } from './components/AllSessions'
import { modelsFor } from './models'
import { showMenu, promptText } from './ui'

const root = document.getElementById('app')!
const state: AppState = initialState()

// Sessions whose process died (F4). Cleared when reconnected/relaunched.
const reconnect = new Set<string>()

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

// F3: launch a session — prompt for a name first, then pick a model.
async function launchFlow(provider: Provider) {
  const proj = currentProject()
  if (!proj) return
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
          useContainer: proj.hasDevcontainer // NN2/D26
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
        window.agentIDE.ptyKill(session.id)
        session.status = 'archived'
        reconnect.delete(session.id)
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
  const projectSessions = state.sessions.filter((s) => s.projectId === proj.id)
  const activeSession = projectSessions.find((s) => s.id === state.activeSessionId) ?? null

  loadTree(proj.id, proj.localPath)
  body.appendChild(Explorer({ projectName: proj.name, tree: trees.get(proj.id) ?? [] }))
  const terminalEl = activeSession ? terminalFor(activeSession.id, proj.localPath) : undefined
  body.appendChild(SupervisionView({ session: activeSession, projectName: proj.name, terminalEl }))
  body.appendChild(
    Cockpit({
      sessions: projectSessions,
      activeSessionId: state.activeSessionId,
      reconnect,
      onLaunch: launchFlow,
      onSelectSession: (id) => { state.activeSessionId = id; render() },
      onSessionMenu: openSessionMenu
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
