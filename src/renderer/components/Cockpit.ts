import { PROVIDERS, isTerminalSession, type Provider, type Session } from '@shared/types'

export type ProviderHealth = 'healthy' | 'not-logged-in' | 'not-installed' | 'unknown'

export interface CockpitProps {
  sessions: Session[]
  activeSessionId: string | null
  /** session ids whose process died and need reconnect (F4). */
  reconnect?: Set<string>
  /** last-known connection health per provider (F8/F9). */
  health?: Partial<Record<Provider, ProviderHealth>>
  onLaunch: (provider: Provider) => void
  onSelectSession: (id: string) => void
  onSessionMenu?: (session: Session, x: number, y: number) => void
  onProviderMenu?: (provider: Provider, x: number, y: number) => void
  /** F13: open a plain shell session (the Terminal tab). */
  onOpenTerminal?: () => void
  /** F14: show a "Start container" button (devcontainer projects only). */
  showContainerButton?: boolean
  containerState?: 'none' | 'stopped' | 'starting' | 'running' | 'error'
  onStartContainer?: () => void
}

const PROVIDER_LABEL: Record<Provider, string> = {
  codex: 'Codex',
  claude: 'Claude',
  gemini: 'Gemini'
}

function sessionCard(
  s: Session,
  active: boolean,
  needsReconnect: boolean,
  onSelect: (id: string) => void,
  onMenu?: (session: Session, x: number, y: number) => void
): HTMLElement {
  const card = document.createElement('div')
  const cls = ['scard']
  if (active) cls.push('active')
  if (s.status === 'running') cls.push('run')
  if (s.status === 'idle') cls.push('idle')
  if (s.status === 'archived') cls.push('archived')
  if (needsReconnect) cls.push('reconnect')
  card.className = cls.join(' ')
  card.onclick = () => onSelect(s.id)

  const top = document.createElement('div')
  top.className = 'top'
  const st = document.createElement('span')
  st.className = 'st'
  const nm = document.createElement('span')
  nm.className = 'nm'
  nm.textContent = s.objective
  const mdl = document.createElement('span')
  mdl.className = 'mdl'
  mdl.textContent = s.model
  top.append(st, nm, mdl)
  if (onMenu) {
    const dots = document.createElement('span')
    dots.className = 'dots'
    dots.textContent = '⋯'
    dots.title = 'Session menu'
    dots.onclick = (e) => {
      e.stopPropagation()
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
      onMenu(s, r.right, r.bottom)
    }
    top.appendChild(dots)
  }
  card.appendChild(top)

  if (needsReconnect) {
    const tag = document.createElement('div')
    tag.className = 'reconnect-tag'
    tag.textContent = '⚠ needs reconnect'
    card.appendChild(tag)
  } else {
    const meta = document.createElement('div')
    meta.className = 'meta'
    const status = document.createElement('span')
    status.textContent = s.status === 'archived' ? 'archived' : s.status
    meta.appendChild(status)
    card.appendChild(meta)
  }

  return card
}

/** Right-hand cockpit: Library (deferred) + Sessions grouped by provider + launchers. */
export function Cockpit(p: CockpitProps): HTMLElement {
  const el = document.createElement('div')
  el.className = 'cockpit'

  // title
  const title = document.createElement('div')
  title.className = 'cp-title'
  const glyph = document.createElement('span')
  glyph.className = 'glyph'
  title.append(glyph, document.createTextNode('AGENT COCKPIT'))
  el.appendChild(title)

  // library (deferred — greyed "SOON" per D14)
  const libSec = document.createElement('div')
  libSec.className = 'cp-sec'
  libSec.textContent = 'Library'
  el.appendChild(libSec)
  const pills = document.createElement('div')
  pills.className = 'libpills soon'
  pills.innerHTML =
    '<span class="pill">📌 Prompts<b>—</b><span class="badge">SOON</span></span>' +
    '<span class="pill">🧠 Skills<b>—</b></span>' +
    '<span class="pill">⚙ Flows<b>—</b></span>'
  el.appendChild(pills)

  const div = document.createElement('div')
  div.className = 'cp-div'
  el.appendChild(div)

  // F14: Start-container button (devcontainer projects only)
  if (p.showContainerButton) {
    const cbar = document.createElement('div')
    cbar.className = 'container-bar'
    const st = p.containerState ?? 'none'
    const btn = document.createElement('button')
    btn.className = 'container-btn ' + st
    const labels: Record<string, string> = {
      none: '▶ Build & start container',
      stopped: '▶ Restart container',
      starting: '◐ Starting…',
      running: '● Container running',
      error: '⚠ Start failed — retry'
    }
    btn.textContent = labels[st]
    btn.disabled = st === 'starting' || st === 'running'
    btn.onclick = () => p.onStartContainer?.()
    cbar.appendChild(btn)
    el.appendChild(cbar)
  }

  // sessions
  const sesSec = document.createElement('div')
  sesSec.className = 'cp-sec'
  sesSec.textContent = 'Sessions · this project'
  el.appendChild(sesSec)

  const reconnect = p.reconnect ?? new Set<string>()
  const list = document.createElement('div')
  list.className = 'sessions'
  for (const provider of PROVIDERS) {
    const provSessions = p.sessions.filter((x) => x.provider === provider && !isTerminalSession(x.id))
    const group = document.createElement('div')
    group.className = 'provgrp'
    const row = document.createElement('div')
    row.className = `provrow ${provider}`
    const pdot = document.createElement('span')
    pdot.className = 'pdot'
    const label = document.createTextNode(PROVIDER_LABEL[provider])
    // F8/F4: connection indicator — prefer known health, else session reconnect state.
    const h = p.health?.[provider]
    const live = document.createElement('span')
    const anyDown = provSessions.some((s) => reconnect.has(s.id))
    const anyLive = provSessions.some((s) => s.status === 'running' && !reconnect.has(s.id))
    let txt = '', down = false
    if (h === 'healthy') { txt = '● live'; down = false }
    else if (h === 'not-logged-in') { txt = '● login needed'; down = true }
    else if (h === 'not-installed') { txt = '● not installed'; down = true }
    else if (h === 'unknown') { txt = '● ?'; down = false }
    else if (provSessions.length) { txt = anyDown && !anyLive ? '● reconnect' : '● live'; down = anyDown && !anyLive }
    if (txt) { live.className = 'live' + (down ? ' down' : ''); live.textContent = txt }
    const grow = document.createElement('span')
    grow.className = 'grow'
    const add = document.createElement('span')
    add.className = 'add'
    add.textContent = '＋'
    add.onclick = () => p.onLaunch(provider)
    // F9: provider-tag ⋯ menu (login / health / install)
    const dots = document.createElement('span')
    dots.className = 'add prov-dots'
    dots.textContent = '⋯'
    dots.title = `${PROVIDER_LABEL[provider]} connection`
    dots.onclick = (e) => {
      e.stopPropagation()
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
      p.onProviderMenu?.(provider, r.right, r.bottom)
    }
    row.append(pdot, label, live, grow, add, dots)
    group.appendChild(row)

    for (const s of provSessions) {
      group.appendChild(sessionCard(s, s.id === p.activeSessionId, reconnect.has(s.id), p.onSelectSession, p.onSessionMenu))
    }
    list.appendChild(group)
  }

  // F13: Terminal group — plain shells (no agent), opened instantly via its +.
  const termSessions = p.sessions.filter((x) => isTerminalSession(x.id))
  const tgroup = document.createElement('div')
  tgroup.className = 'provgrp'
  const trow = document.createElement('div')
  trow.className = 'provrow terminal'
  const tdot = document.createElement('span')
  tdot.className = 'pdot'
  const tgrow = document.createElement('span')
  tgrow.className = 'grow'
  const tadd = document.createElement('span')
  tadd.className = 'add'
  tadd.textContent = '＋'
  tadd.title = 'Open a terminal'
  tadd.onclick = () => p.onOpenTerminal?.()
  trow.append(tdot, document.createTextNode('Terminal'), tgrow, tadd)
  tgroup.appendChild(trow)
  for (const s of termSessions) {
    tgroup.appendChild(sessionCard(s, s.id === p.activeSessionId, reconnect.has(s.id), p.onSelectSession, p.onSessionMenu))
  }
  list.appendChild(tgroup)

  el.appendChild(list)

  // launchers
  const launch = document.createElement('div')
  launch.className = 'launch'
  for (const provider of PROVIDERS) {
    const btn = document.createElement('button')
    btn.className = provider
    const pd = document.createElement('span')
    pd.className = 'pd'
    btn.append(pd, document.createTextNode(PROVIDER_LABEL[provider]))
    btn.onclick = () => p.onLaunch(provider)
    launch.appendChild(btn)
  }
  el.appendChild(launch)

  return el
}
