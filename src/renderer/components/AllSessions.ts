import type { Project, Session } from '@shared/types'

export type BoardMode = 'live' | 'archived'

export interface AllSessionsProps {
  projects: Project[]
  sessions: Session[]
  /** Which set to show: live (default board) or archived (for cleanup). */
  mode: BoardMode
  onSetMode: (mode: BoardMode) => void
  onOpen: (projectId: string, sessionId: string) => void
  /** Permanently delete an archived session (shown only in archived mode). */
  onDelete?: (session: Session) => void
}

/** ⌘ home: sessions across every project, grouped by project, newest first (NN4).
 *  A Live | Archived toggle switches between the live board and the archived
 *  sessions (where they can be permanently deleted). */
export function AllSessions(p: AllSessionsProps): HTMLElement {
  const el = document.createElement('div')
  el.className = 'allsessions'

  const archived = p.mode === 'archived'
  const shown = p.sessions
    .filter((s) => (archived ? s.status === 'archived' : s.status !== 'archived'))
    .sort((a, b) => b.createdAt - a.createdAt)

  const h2 = document.createElement('h2')
  h2.textContent = 'All sessions'
  el.appendChild(h2)

  // Live | Archived toggle.
  const seg = document.createElement('div')
  seg.className = 'as-toggle'
  for (const m of ['live', 'archived'] as const) {
    const b = document.createElement('button')
    b.className = 'as-seg' + (p.mode === m ? ' on' : '')
    b.textContent = m === 'live' ? 'Live' : 'Archived'
    b.onclick = () => { if (p.mode !== m) p.onSetMode(m) }
    seg.appendChild(b)
  }
  el.appendChild(seg)

  const sub = document.createElement('div')
  sub.className = 'sub'
  sub.textContent = archived
    ? `${shown.length} archived across ${p.projects.length} projects`
    : `${shown.length} live across ${p.projects.length} projects`
  el.appendChild(sub)

  if (shown.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'as-empty'
    empty.textContent = archived ? 'No archived sessions.' : 'No live sessions.'
    el.appendChild(empty)
    return el
  }

  for (const proj of p.projects) {
    const projSessions = shown.filter((s) => s.projectId === proj.id)
    if (projSessions.length === 0) continue

    const group = document.createElement('div')
    group.className = 'as-proj'
    const head = document.createElement('div')
    head.className = 'h'
    head.textContent = proj.name
    group.appendChild(head)

    for (const s of projSessions) {
      const row = document.createElement('div')
      row.className = 'as-row' + (archived ? ' arch' : '')
      const pv = document.createElement('span')
      pv.className = `pv ${s.provider}`
      const nm = document.createElement('span')
      nm.className = 'nm'
      nm.textContent = s.objective
      const mdl = document.createElement('span')
      mdl.className = 'mdl'
      mdl.textContent = s.model
      const stt = document.createElement('span')
      stt.className = 'stt'
      stt.textContent = s.status
      row.append(pv, nm, mdl, stt)

      if (archived && p.onDelete) {
        // Delete action — opening the row is not useful for archived chats; the
        // primary action here is cleanup.
        const del = document.createElement('span')
        del.className = 'as-del'
        del.textContent = '🗑'
        del.title = 'Delete permanently'
        del.onclick = (e) => { e.stopPropagation(); p.onDelete!(s) }
        row.appendChild(del)
      } else {
        row.onclick = () => p.onOpen(proj.id, s.id)
      }
      group.appendChild(row)
    }
    el.appendChild(group)
  }

  return el
}
