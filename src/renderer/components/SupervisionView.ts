import type { Provider, Session } from '@shared/types'

const PROVIDER_VAR: Record<Provider, string> = {
  codex: 'var(--codex)',
  claude: 'var(--claude)',
  gemini: 'var(--gemini)'
}

export interface SupervisionProps {
  session: Session | null
  projectName: string
  /** L2+ supplies a terminal element to mount; L1 passes nothing (placeholder). */
  terminalEl?: HTMLElement
}

/** Center pane: the active session's header + its live terminal (L2). */
export function SupervisionView(p: SupervisionProps): HTMLElement {
  const editor = document.createElement('div')
  editor.className = 'editor'

  const tabs = document.createElement('div')
  tabs.className = 'ed-tabs'
  const tab = document.createElement('div')
  tab.className = 'ed-tab on'
  const dot = document.createElement('span')
  dot.className = 'dot'
  tab.append(dot, document.createTextNode(p.session ? p.session.objective : 'No session'))
  tabs.appendChild(tab)
  editor.appendChild(tabs)

  const superv = document.createElement('div')
  superv.className = 'superv'

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
  editor.appendChild(superv)

  return editor
}
