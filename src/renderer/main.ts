import './cockpit.css'
import type { Provider } from '@shared/types'
import { initialState, liveCounts, type AppState } from './state'
import { ProjectRail } from './components/ProjectRail'
import { Cockpit } from './components/Cockpit'
import { SupervisionView } from './components/SupervisionView'
import { Explorer, type FileNode } from './components/Explorer'
import { ModelPicker } from './components/ModelPicker'
import { RepoPicker } from './components/RepoPicker'
import { SessionTerminal } from './components/SessionTerminal'
import { modelsFor } from './models'

const root = document.getElementById('app')!
const state: AppState = initialState()

// Cache one terminal element per session so re-renders don't respawn the pty.
const terminals = new Map<string, HTMLElement>()
// Sessions launched via session:launch already have a pty spawned in main, so
// their terminals attach-only. Seed/mock sessions spawn a plain bash.
const launchedSessions = new Set<string>()
function terminalFor(sessionId: string, cwd: string): HTMLElement {
  let el = terminals.get(sessionId)
  if (!el) {
    el = launchedSessions.has(sessionId)
      ? SessionTerminal(sessionId) // attach-only
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

function currentProject() {
  return state.projects.find((p) => p.id === state.currentProjectId)!
}

// File tree per project, loaded lazily from the real filesystem.
const trees = new Map<string, FileNode[]>()
function loadTree(projectId: string, localPath: string) {
  if (trees.has(projectId)) return
  trees.set(projectId, []) // mark in-flight so we don't double-fetch
  window.agentIDE.fsTree(localPath).then((t) => {
    trees.set(projectId, t as FileNode[])
    render()
  })
}

function openRepoPicker() {
  window.agentIDE.githubRepos().then((repos) => {
    const picker = RepoPicker({
      repos,
      onPick: async (repo) => {
        closePicker()
        try {
          const proj = await window.agentIDE.projectsAdd(repo)
          if (!state.projects.find((p) => p.id === proj.id)) state.projects.push(proj)
          state.currentProjectId = proj.id
          state.view = 'cockpit'
          render()
        } catch (err) {
          console.error('add project failed', err)
        }
      },
      onCancel: closePicker
    })
    picker.id = 'picker-overlay'
    document.body.appendChild(picker)
  })
}

function openPicker(provider: Provider) {
  const picker = ModelPicker({
    provider,
    models: modelsFor(provider),
    onPick: async (prov, modelId) => {
      closePicker()
      const proj = currentProject()
      try {
        const session = await window.agentIDE.sessionLaunch({
          projectId: proj.id,
          provider: prov,
          model: modelId,
          objective: `New ${prov} session`,
          cwd: proj.localPath,
          // D26: auto-approve only inside a devcontainer; host projects prompt.
          autoApprove: proj.hasDevcontainer
        })
        launchedSessions.add(session.id)
        state.sessions.push(session)
        state.activeSessionId = session.id
        state.view = 'cockpit'
        render()
      } catch (err) {
        console.error('session launch failed', err)
      }
    },
    onCancel: closePicker
  })
  picker.id = 'picker-overlay'
  document.body.appendChild(picker)
}
function closePicker() {
  document.getElementById('picker-overlay')?.remove()
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
    onAdd: openRepoPicker
  })
  body.appendChild(rail)
  body.appendChild(activityBar())

  const proj = currentProject()
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
      onLaunch: openPicker,
      onSelectSession: (id) => { state.activeSessionId = id; render() }
    })
  )

  root.appendChild(body)
}

render()
