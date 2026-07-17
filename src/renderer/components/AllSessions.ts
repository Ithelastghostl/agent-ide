import type { Project, Session } from '@shared/types'

export interface AllSessionsProps {
  projects: Project[]
  sessions: Session[]
  onOpen: (projectId: string, sessionId: string) => void
  /** B8: commit+push the IDE-owned history repo; resolves per-step results. */
  onSyncHistory?: () => Promise<{ step: string; ok: boolean; skipped?: boolean; error?: string }[]>
}

/** ⌘ home: LIVE sessions across every project, grouped by project, newest first
 *  (NN4). Archived sessions are intentionally hidden here — they live in history,
 *  not on the live board. */
export function AllSessions(p: AllSessionsProps): HTMLElement {
  const el = document.createElement('div')
  el.className = 'allsessions'

  // Only live (non-archived) sessions, most-recent first.
  const liveSessions = p.sessions
    .filter((s) => s.status !== 'archived')
    .sort((a, b) => b.createdAt - a.createdAt)

  const h2 = document.createElement('h2')
  h2.textContent = 'All sessions'
  el.appendChild(h2)
  const sub = document.createElement('div')
  sub.className = 'sub'
  sub.textContent = `${liveSessions.length} live across ${p.projects.length} projects`
  el.appendChild(sub)

  if (p.onSyncHistory) {
    const actions = document.createElement('div')
    actions.className = 'as-actions'
    const btn = document.createElement('button')
    btn.className = 'hsync'
    btn.textContent = 'Sync history'
    const result = document.createElement('span')
    result.className = 'hsync-result'
    btn.onclick = async () => {
      btn.disabled = true
      result.className = 'hsync-result'
      result.textContent = 'syncing…'
      try {
        const steps = await p.onSyncHistory!()
        const bad = steps.find((s) => !s.ok)
        if (bad) {
          result.className = 'hsync-result err'
          result.textContent = `${bad.step} failed: ${bad.error ?? 'unknown error'}`
        } else {
          result.textContent = steps.some((s) => s.skipped) ? 'already up to date' : 'history pushed'
        }
      } catch (err) {
        result.className = 'hsync-result err'
        result.textContent = (err as Error).message
      }
      btn.disabled = false
    }
    actions.append(btn, result)
    el.appendChild(actions)
  }

  for (const proj of p.projects) {
    const projSessions = liveSessions.filter((s) => s.projectId === proj.id)
    if (projSessions.length === 0) continue

    const group = document.createElement('div')
    group.className = 'as-proj'
    const head = document.createElement('div')
    head.className = 'h'
    head.textContent = proj.name
    group.appendChild(head)

    for (const s of projSessions) {
      const row = document.createElement('div')
      row.className = 'as-row'
      row.onclick = () => p.onOpen(proj.id, s.id)
      const pv = document.createElement('span')
      pv.className = `pv ${s.provider}`
      const nm = document.createElement('span')
      nm.className = 'nm'
      nm.textContent = s.objective
      const mdl = document.createElement('span')
      mdl.className = 'mdl'
      mdl.textContent = s.model
      // M-LOG-a (§4.5.2): task label chip + lifecycle status. Terminals/unlabeled
      // sessions have no taskKind → no chip.
      const chips: HTMLElement[] = []
      if (s.taskKind) {
        const chip = document.createElement('span')
        chip.className = `task-chip ${s.taskKind}`
        chip.textContent = s.taskKind === 'product' && s.taskSubkind ? s.taskSubkind : s.taskKind
        chips.push(chip)
        if (s.taskStatus && s.taskStatus !== 'open') {
          const ts = document.createElement('span')
          ts.className = `task-status ${s.taskStatus}`
          ts.textContent = s.taskStatus
          chips.push(ts)
        }
      }
      const stt = document.createElement('span')
      stt.className = 'stt'
      stt.textContent = s.status
      row.append(pv, nm, ...chips, mdl, stt)
      group.appendChild(row)
    }
    el.appendChild(group)
  }

  return el
}
