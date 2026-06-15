import { PROVIDERS, type Provider, type Session } from '@shared/types'

export interface CockpitProps {
  sessions: Session[]
  activeSessionId: string | null
  onLaunch: (provider: Provider) => void
  onSelectSession: (id: string) => void
}

const PROVIDER_LABEL: Record<Provider, string> = {
  codex: 'Codex',
  claude: 'Claude',
  gemini: 'Gemini'
}

function sessionCard(s: Session, active: boolean, onSelect: (id: string) => void): HTMLElement {
  const card = document.createElement('div')
  const cls = ['scard']
  if (active) cls.push('active')
  if (s.status === 'running') cls.push('run')
  if (s.status === 'idle') cls.push('idle')
  if (s.status === 'archived') cls.push('archived')
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
  card.appendChild(top)

  const meta = document.createElement('div')
  meta.className = 'meta'
  const status = document.createElement('span')
  status.textContent = s.status === 'archived' ? 'archived' : s.status
  meta.appendChild(status)
  card.appendChild(meta)

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

  // sessions
  const sesSec = document.createElement('div')
  sesSec.className = 'cp-sec'
  sesSec.textContent = 'Sessions · this project'
  el.appendChild(sesSec)

  const list = document.createElement('div')
  list.className = 'sessions'
  for (const provider of PROVIDERS) {
    const group = document.createElement('div')
    group.className = 'provgrp'
    const row = document.createElement('div')
    row.className = `provrow ${provider}`
    const pdot = document.createElement('span')
    pdot.className = 'pdot'
    const label = document.createTextNode(PROVIDER_LABEL[provider])
    const grow = document.createElement('span')
    grow.className = 'grow'
    const add = document.createElement('span')
    add.className = 'add'
    add.textContent = '＋'
    add.onclick = () => p.onLaunch(provider)
    row.append(pdot, label, grow, add)
    group.appendChild(row)

    for (const s of p.sessions.filter((x) => x.provider === provider)) {
      group.appendChild(sessionCard(s, s.id === p.activeSessionId, p.onSelectSession))
    }
    list.appendChild(group)
  }
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
