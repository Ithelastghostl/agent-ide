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

/** An HTML report open as a rendered tab. `name` is the tab label. */
export interface OpenReport {
  path: string
  name: string
}

/** Which tab is active: the session terminal, a file editor, or a rendered report. */
export type ActiveTab =
  | { kind: 'session' }
  | { kind: 'file'; path: string }
  | { kind: 'report'; path: string }

/** One session pane in the (optionally split) cockpit: its session, the terminal
 *  element to mount, and an optional pending-review affordance to show above it. */
export interface SessionPane {
  session: Session | null
  terminalEl?: HTMLElement
  /** "Review & insert" affordance for handoff/linear material (S6); null if none. */
  reviewEl?: HTMLElement | null
  /** Whether this pane is the focused one (its writes/inserts target it). */
  focused: boolean
  /** Focus this pane (single-click on the pane). */
  onFocus?: () => void
}

export interface SupervisionProps {
  session: Session | null
  projectName: string
  /** Files open as editor tabs (alongside the session tab). */
  openFiles: OpenFile[]
  /** HTML reports open as rendered tabs (F15). */
  openReports: OpenReport[]
  activeTab: ActiveTab
  /** Terminal element for the session tab (L2+); omitted → placeholder. */
  terminalEl?: HTMLElement
  /** Editor element for the active file tab; omitted when a session tab is active. */
  fileEl?: HTMLElement
  /** Rendered-report element for the active report tab (a sandboxed iframe). */
  reportEl?: HTMLElement
  /** Pending-review affordance for the primary session pane (S6); null if none. */
  reviewEl?: HTMLElement | null
  // --- Split view (S6) --------------------------------------------------------
  /** When set, the session tab shows TWO session panes side-by-side. The primary
   *  pane uses `terminalEl`/`session`; the second pane is described here. */
  secondPane?: SessionPane
  /** Whether split view is on (a layout toggle in the tab strip flips it). */
  splitOn?: boolean
  /** Toggle split view on/off. */
  onToggleSplit?: () => void
  /** Hand off the focused session's tail to the other pane (split view only). */
  onHandoff?: () => void
  /** Focus the primary pane (split view). */
  onFocusPrimary?: () => void
  onSelectTab: (tab: ActiveTab) => void
  onCloseFile: (path: string) => void
  onCloseReport: (path: string) => void
}

/** Build one session pane: provider head, optional pending-review affordance, and
 *  the terminal (or a placeholder when none is mounted). */
function sessionPane(
  session: Session | null,
  projectName: string,
  terminalEl: HTMLElement | undefined,
  reviewEl: HTMLElement | null | undefined,
  opts: { focused?: boolean; onFocus?: () => void; splittable?: boolean } = {}
): HTMLElement {
  const pane = document.createElement('div')
  pane.className = 'sv-pane' + (opts.focused ? ' focused' : '')
  if (opts.onFocus) pane.onclick = () => opts.onFocus!()

  if (session) {
    const head = document.createElement('div')
    head.className = 'sv-head'
    const sdot = document.createElement('span')
    sdot.className = 'dot'
    const col = PROVIDER_VAR[session.provider]
    sdot.style.color = col
    sdot.style.background = col
    const obj = document.createElement('div')
    obj.className = 'obj'
    const b = document.createElement('b')
    b.textContent = session.objective
    const span = document.createElement('span')
    span.textContent = `${session.provider} · ${projectName}`
    obj.append(b, span)
    const chip = document.createElement('span')
    chip.className = 'chip'
    chip.textContent = session.model
    head.append(sdot, obj, chip)
    pane.appendChild(head)
  }

  // Pending-review affordance (S6) sits directly above the terminal.
  if (reviewEl) pane.appendChild(reviewEl)

  const host = terminalEl ?? document.createElement('div')
  if (!terminalEl) {
    host.className = 'terminal-host'
    host.style.color = 'var(--text-muted)'
    host.style.fontFamily = 'Menlo, monospace'
    host.style.fontSize = '12px'
    host.style.padding = '14px 16px'
    host.textContent = session ? '› terminal mounts here (L2)…' : '› select or launch a session'
  }
  pane.appendChild(host)
  return pane
}

/** Center pane: a tab strip (session + open files) over the active tab's content
 *  (the live terminal(s), a file editor, or a rendered report). The session tab
 *  supports a two-pane SPLIT VIEW (S6). */
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

  // One tab per open report (rendered HTML), with a close button. F15.
  for (const r of p.openReports) {
    const active = p.activeTab.kind === 'report' && p.activeTab.path === r.path
    const tab = document.createElement('div')
    tab.className = 'ed-tab report' + (active ? ' on' : '')
    const name = document.createElement('span')
    name.className = 'fname'
    name.textContent = r.name
    tab.appendChild(name)
    const close = document.createElement('span')
    close.className = 'close'
    close.textContent = '×'
    close.title = 'Close'
    close.onclick = (e) => { e.stopPropagation(); p.onCloseReport(r.path) }
    tab.appendChild(close)
    tab.onclick = () => p.onSelectTab({ kind: 'report', path: r.path })
    tabs.appendChild(tab)
  }

  // Split-view controls live on the right of the tab strip (session tab only).
  if (sessionActive && p.session) {
    const grow = document.createElement('span')
    grow.className = 'ed-grow'
    tabs.appendChild(grow)
    if (p.splitOn && p.onHandoff) {
      const handoff = document.createElement('button')
      handoff.className = 'ed-handoff'
      handoff.textContent = '⇄ Hand off'
      handoff.title = 'Register the focused session’s tail as review material for the other pane'
      handoff.onclick = (e) => { e.stopPropagation(); p.onHandoff!() }
      tabs.appendChild(handoff)
    }
    if (p.onToggleSplit) {
      const split = document.createElement('button')
      split.className = 'ed-split' + (p.splitOn ? ' on' : '')
      split.textContent = p.splitOn ? '▣ Single' : '▥ Split'
      split.title = p.splitOn ? 'Return to a single terminal pane' : 'Show two terminals side by side'
      split.onclick = (e) => { e.stopPropagation(); p.onToggleSplit!() }
      tabs.appendChild(split)
    }
  }
  editor.appendChild(tabs)

  const superv = document.createElement('div')
  superv.className = 'superv'

  if (p.activeTab.kind === 'report' && p.reportEl) {
    // Rendered report fills the pane (a sandboxed iframe; its own bar is inside).
    superv.appendChild(p.reportEl)
  } else if (p.activeTab.kind === 'file' && p.fileEl) {
    // File editor fills the pane (its own header lives inside fileEl).
    superv.appendChild(p.fileEl)
  } else if (p.splitOn && p.secondPane) {
    // SPLIT VIEW: two session panes side by side (S6).
    const grid = document.createElement('div')
    grid.className = 'sv-split'
    grid.appendChild(sessionPane(p.session, p.projectName, p.terminalEl, p.reviewEl, {
      focused: !p.secondPane.focused, onFocus: p.onFocusPrimary
    }))
    grid.appendChild(sessionPane(p.secondPane.session, p.projectName, p.secondPane.terminalEl, p.secondPane.reviewEl, {
      focused: p.secondPane.focused, onFocus: p.secondPane.onFocus
    }))
    superv.appendChild(grid)
  } else {
    // Single session pane.
    superv.appendChild(sessionPane(p.session, p.projectName, p.terminalEl, p.reviewEl))
  }

  editor.appendChild(superv)
  return editor
}
