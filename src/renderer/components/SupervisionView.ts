import type { Provider, Session } from '@shared/types'

const PROVIDER_VAR: Record<Provider, string> = {
  codex: 'var(--codex)',
  claude: 'var(--claude)',
  gemini: 'var(--gemini)'
}

/** A file open in an editor tab. `dirty` shows an unsaved-changes marker. */
export interface OpenFile {
  path: string
  name: string
  dirty: boolean
}

/** Which tab is active: the session terminal, or a specific open file. */
export type ActiveTab = { kind: 'session' } | { kind: 'file'; path: string }

export interface SupervisionProps {
  session: Session | null
  projectName: string
  /** Files open as editor tabs (alongside the session tab). */
  openFiles: OpenFile[]
  activeTab: ActiveTab
  /** Terminal element for the session tab (L2+); omitted → placeholder. */
  terminalEl?: HTMLElement
  /** Editor element for the active file tab; omitted when a session tab is active. */
  fileEl?: HTMLElement
  onSelectTab: (tab: ActiveTab) => void
  onCloseFile: (path: string) => void
}

/** Center pane: a tab strip (session + open files) over the active tab's content
 *  (the live terminal, or a file editor). */
export function SupervisionView(p: SupervisionProps): HTMLElement {
  const editor = document.createElement('div')
  editor.className = 'editor'

  const tabs = document.createElement('div')
  tabs.className = 'ed-tabs'

  // Session tab (always present; the cockpit's primary view).
  const sessionActive = p.activeTab.kind === 'session'
  const sTab = document.createElement('div')
  sTab.className = 'ed-tab' + (sessionActive ? ' on' : '')
  const sDot = document.createElement('span')
  sDot.className = 'dot'
  sTab.append(sDot, document.createTextNode(p.session ? p.session.objective : 'No session'))
  sTab.onclick = () => p.onSelectTab({ kind: 'session' })
  tabs.appendChild(sTab)

  // One tab per open file, with a close button and a dirty marker.
  for (const f of p.openFiles) {
    const active = p.activeTab.kind === 'file' && p.activeTab.path === f.path
    const tab = document.createElement('div')
    tab.className = 'ed-tab file' + (active ? ' on' : '')
    const name = document.createElement('span')
    name.className = 'fname'
    name.textContent = f.name
    tab.appendChild(name)
    const close = document.createElement('span')
    close.className = 'close'
    close.textContent = f.dirty ? '●' : '×'
    close.title = f.dirty ? 'Unsaved changes — click to close' : 'Close'
    close.onclick = (e) => { e.stopPropagation(); p.onCloseFile(f.path) }
    tab.appendChild(close)
    tab.onclick = () => p.onSelectTab({ kind: 'file', path: f.path })
    tabs.appendChild(tab)
  }
  editor.appendChild(tabs)

  const superv = document.createElement('div')
  superv.className = 'superv'

  if (p.activeTab.kind === 'file' && p.fileEl) {
    // File editor fills the pane (its own header lives inside fileEl).
    superv.appendChild(p.fileEl)
  } else {
    if (p.session) {
      const head = document.createElement('div')
      head.className = 'sv-head'
      const sdot = document.createElement('span')
      sdot.className = 'dot'
      const col = PROVIDER_VAR[p.session.provider]
      sdot.style.color = col
      sdot.style.background = col
      const obj = document.createElement('div')
      obj.className = 'obj'
      const b = document.createElement('b')
      b.textContent = p.session.objective
      const span = document.createElement('span')
      span.textContent = `${p.session.provider} · ${p.projectName}`
      obj.append(b, span)
      const chip = document.createElement('span')
      chip.className = 'chip'
      chip.textContent = p.session.model
      head.append(sdot, obj, chip)
      superv.appendChild(head)
    }

    const host = p.terminalEl ?? document.createElement('div')
    if (!p.terminalEl) {
      host.className = 'terminal-host'
      host.style.color = 'var(--text-muted)'
      host.style.fontFamily = 'Menlo, monospace'
      host.style.fontSize = '12px'
      host.style.padding = '14px 16px'
      host.textContent = p.session
        ? '› terminal mounts here (L2)…'
        : '› select or launch a session'
    }
    superv.appendChild(host)
  }

  editor.appendChild(superv)
  return editor
}
