import type { Project, Session } from '@shared/types'

export interface AllSessionsProps {
  projects: Project[]
  sessions: Session[]
  onOpen: (projectId: string, sessionId: string) => void
}

/** ⌘ home: every session across every project, grouped by project (NN4). */
export function AllSessions(p: AllSessionsProps): HTMLElement {
  const el = document.createElement('div')
  el.className = 'allsessions'

  const h2 = document.createElement('h2')
  h2.textContent = 'All sessions'
  el.appendChild(h2)
  const sub = document.createElement('div')
  sub.className = 'sub'
  const live = p.sessions.filter((s) => s.status !== 'archived').length
  sub.textContent = `${live} live · ${p.sessions.length} total across ${p.projects.length} projects`
  el.appendChild(sub)

  for (const proj of p.projects) {
    const projSessions = p.sessions.filter((s) => s.projectId === proj.id)
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
      const stt = document.createElement('span')
      stt.className = 'stt'
      stt.textContent = s.status
      row.append(pv, nm, mdl, stt)
      group.appendChild(row)
    }
    el.appendChild(group)
  }

  return el
}
