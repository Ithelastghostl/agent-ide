import {
  PROVIDERS,
  isTerminalSession,
  type AttentionState,
  type CostSummary,
  type Provider,
  type Session,
  type LibraryCategory
} from '@shared/types'
import { stageChip, approvalIndicator, effectiveStageOf } from './StageChip'
import { attentionBadge, costChip } from './costChip'

export type ProviderHealth = 'healthy' | 'not-logged-in' | 'not-installed' | 'unknown'

export interface CockpitProps {
  sessions: Session[]
  activeSessionId: string | null
  /** session ids whose process died and need reconnect (F4). */
  reconnect?: Set<string>
  /** last-known connection health per provider (F8/F9). */
  health?: Partial<Record<Provider, ProviderHealth>>
  /** S5: ephemeral attention flags per session id (flagged sessions only). */
  attention?: Map<string, Exclude<AttentionState, null>>
  /** S5: last-known cost summary per session id (absent → no chip). */
  costs?: Map<string, CostSummary>
  /** Library item counts per category (D14). Undefined → not loaded yet. */
  libraryCounts?: { prompts: number; skills: number; workflows: number; agents: number }
  /** Clicking a library pill opens that category's list. */
  onLibraryPill?: (category: LibraryCategory) => void
  onLaunch: (provider: Provider) => void
  onSelectSession: (id: string) => void
  onSessionMenu?: (session: Session, x: number, y: number) => void
  /** S8: resolve a session's agent preset relPath → a display name for its chip.
   *  Returns null/undefined when the session was not launched from an agent. */
  agentNameFor?: (session: Session) => string | null | undefined
  onProviderMenu?: (provider: Provider, x: number, y: number) => void
  /** F13: open a plain shell session (the Terminal tab). */
  onOpenTerminal?: () => void
  /** F14: show a "Start container" button (devcontainer projects only). */
  showContainerButton?: boolean
  containerState?: 'none' | 'stopped' | 'starting' | 'running' | 'error'
  onStartContainer?: () => void
  /** Stop a running container (reversible). Shown when containerState==='running'. */
  onStopContainer?: () => void
  /** Where NEW sessions run: true = inside the container, false = on the host.
   *  Distinct from containerState, which is only whether Docker has it up. */
  inContainer?: boolean
  /** Flip the project between container and host mode. Affects new sessions
   *  only; running sessions keep the context they launched with. */
  onToggleContainerMode?: () => void
  /** False when the devcontainer CLI is missing. Container launches hard-fail
   *  without it, so the bar warns up front rather than after a dead click.
   *  undefined = not checked yet (say nothing). */
  hasDevcontainerCli?: boolean
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
  onMenu?: (session: Session, x: number, y: number) => void,
  agentName?: string | null,
  att?: Exclude<AttentionState, null>,
  cost?: CostSummary
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

  // S8: agent-preset chip — shown when the session was launched from a library
  // agent. textContent only (no innerHTML) per the P0.D renderer rule.
  if (agentName) {
    const chip = document.createElement('span')
    chip.className = 'agent-chip'
    chip.textContent = `🤖 ${agentName}`
    chip.title = 'Launched from a library agent'
    card.appendChild(chip)
  }

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
    // S3: read-only stage chip + guarded/auto indicator on provider cards.
    if (!isTerminalSession(s.id)) {
      meta.appendChild(stageChip(effectiveStageOf(s)))
      const ind = approvalIndicator(s.spawnedApprovalMode, s.status)
      if (ind) meta.appendChild(ind)
    }
    // S5: attention badge + per-session cost chip (each hidden when absent).
    const badge = attentionBadge(att)
    if (badge) meta.appendChild(badge)
    const chip = costChip(cost)
    if (chip) meta.appendChild(chip)
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

  // Library (D14) — live, clickable pills with real counts. Greyed only until
  // counts load. Clicking a pill opens that category's filterable list.
  const libSec = document.createElement('div')
  libSec.className = 'cp-sec'
  libSec.textContent = 'Library'
  el.appendChild(libSec)
  const pills = document.createElement('div')
  pills.className = 'libpills' + (p.libraryCounts ? '' : ' soon')
  const counts = p.libraryCounts ?? { prompts: 0, skills: 0, workflows: 0, agents: 0 }
  const pillDefs: { icon: string; label: string; category: LibraryCategory; n: number }[] = [
    { icon: '📌', label: 'Prompts', category: 'prompts', n: counts.prompts },
    { icon: '🧠', label: 'Skills', category: 'skills', n: counts.skills },
    { icon: '⚙', label: 'Flows', category: 'workflows', n: counts.workflows },
    { icon: '🤖', label: 'Agents', category: 'agents', n: counts.agents }
  ]
  for (const d of pillDefs) {
    const pill = document.createElement('span')
    pill.className = 'pill'
    const cnt = document.createElement('b')
    cnt.textContent = p.libraryCounts ? String(d.n) : '—'
    pill.append(document.createTextNode(`${d.icon} ${d.label}`), cnt)
    if (p.libraryCounts) pill.onclick = () => p.onLibraryPill?.(d.category)
    pills.appendChild(pill)
  }
  el.appendChild(pills)

  const div = document.createElement('div')
  div.className = 'cp-div'
  el.appendChild(div)

  // F14: container controls (devcontainer projects only). Two separate things,
  // which used to be conflated:
  //   1. WHERE new sessions run — container or host (`inContainer`). This is the
  //      state the user actually cares about, and it was previously invisible:
  //      set once by a dialog with no indicator and no way back.
  //   2. Whether Docker has the container UP (`containerState`) — the lifecycle.
  // A container can be running while sessions still launch on the host, so the
  // bar states both rather than implying one from the other.
  if (p.showContainerButton) {
    const cbar = document.createElement('div')
    cbar.className = 'container-bar'
    const st = p.containerState ?? 'none'
    const inC = p.inContainer === true

    // Line 1: where sessions run, plus the container's own state.
    const status = document.createElement('div')
    status.className = 'cx-status' + (inC ? ' on' : '')
    const dot = document.createElement('span')
    dot.className = 'cx-dot ' + (inC ? 'in' : 'host')
    const label = document.createElement('span')
    label.className = 'cx-where'
    label.textContent = inC ? 'Sessions run in the container' : 'Sessions run on the host'
    const sub = document.createElement('span')
    sub.className = 'cx-sub'
    const stateWord: Record<string, string> = {
      none: 'container not built',
      stopped: 'container stopped',
      starting: 'container starting…',
      running: 'container running',
      error: 'container failed to start'
    }
    sub.textContent = stateWord[st]
    status.append(dot, label, sub)
    cbar.appendChild(status)

    const actions = document.createElement('div')
    actions.className = 'cx-actions'

    // Connect / Disconnect — the mode toggle. Disconnect never stops the
    // container or kills sessions; it only routes NEW sessions to the host.
    const conn = document.createElement('button')
    conn.className = 'container-btn cx-conn' + (inC ? ' on' : '')
    conn.textContent = inC ? '⤫ Disconnect' : '⇥ Connect'
    conn.disabled = st === 'starting'
    conn.title = inC
      ? 'Run new sessions on the host instead. Running sessions are unaffected.'
      : 'Run new sessions inside the container. Starts it first if needed.'
    conn.onclick = () => p.onToggleContainerMode?.()
    actions.appendChild(conn)

    // Lifecycle button: start/stop the container itself.
    const btn = document.createElement('button')
    if (st === 'running') {
      btn.className = 'container-btn cx-life running stop'
      btn.textContent = '⏹ Stop container'
      btn.disabled = false
      btn.onclick = () => p.onStopContainer?.()
    } else {
      btn.className = 'container-btn cx-life ' + st
      const labels: Record<string, string> = {
        none: '▶ Build & start',
        stopped: '▶ Restart',
        starting: '◐ Starting…',
        error: '⚠ Retry start'
      }
      btn.textContent = labels[st]
      btn.disabled = st === 'starting'
      btn.onclick = () => p.onStartContainer?.()
    }
    actions.appendChild(btn)
    cbar.appendChild(actions)

    // Missing CLI: container launches throw before a session exists, which
    // reads as "the button does nothing". Say it here, with the fix.
    if (p.hasDevcontainerCli === false) {
      const warn = document.createElement('div')
      warn.className = 'cx-warn'
      warn.textContent = 'Needs the devcontainer CLI: npm i -g @devcontainers/cli'
      cbar.appendChild(warn)
    }
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
    let txt = '',
      down = false
    if (h === 'healthy') {
      txt = '● live'
      down = false
    } else if (h === 'not-logged-in') {
      txt = '● login needed'
      down = true
    } else if (h === 'not-installed') {
      txt = '● not installed'
      down = true
    } else if (h === 'unknown') {
      txt = '● ?'
      down = false
    } else if (provSessions.length) {
      txt = anyDown && !anyLive ? '● reconnect' : '● live'
      down = anyDown && !anyLive
    }
    if (txt) {
      live.className = 'live' + (down ? ' down' : '')
      live.textContent = txt
    }
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
      group.appendChild(
        sessionCard(
          s,
          s.id === p.activeSessionId,
          reconnect.has(s.id),
          p.onSelectSession,
          p.onSessionMenu,
          p.agentNameFor?.(s),
          p.attention?.get(s.id),
          p.costs?.get(s.id)
        )
      )
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
    // Terminals have no agent preset → undefined for the agentName slot.
    tgroup.appendChild(
      sessionCard(
        s,
        s.id === p.activeSessionId,
        reconnect.has(s.id),
        p.onSelectSession,
        p.onSessionMenu,
        undefined,
        p.attention?.get(s.id),
        p.costs?.get(s.id)
      )
    )
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
