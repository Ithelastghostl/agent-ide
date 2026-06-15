import type { Project } from '@shared/types'

export interface RailProps {
  projects: Project[]
  activeId: string | null
  counts: Record<string, number>
  onSelect: (id: string) => void
  onHome: () => void
  onAdd: () => void
}

/** Two-letter avatar from a repo name: initials of the first two word-segments
 *  ("sample-cli" -> "SC", "sample-api" -> "SA"), else first two chars. */
export function avatarFor(name: string): string {
  const parts = name.split(/[-_ ]+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

/** Far-left project rail (Variant A): ⌘ home + one avatar per project + add. */
export function ProjectRail(p: RailProps): HTMLElement {
  const el = document.createElement('div')
  el.className = 'projrail'

  const home = document.createElement('div')
  home.className = 'home'
  home.textContent = '⌘'
  home.title = 'All sessions'
  home.onclick = p.onHome
  el.appendChild(home)

  for (const pj of p.projects) {
    const d = document.createElement('div')
    d.className = 'pj' + (pj.id === p.activeId ? ' on' : '')
    d.title = pj.name
    const av = document.createElement('span')
    av.className = 'av'
    av.textContent = avatarFor(pj.name)
    d.appendChild(av)
    const n = p.counts[pj.id] ?? 0
    if (n) {
      const c = document.createElement('span')
      // active project's running work shows purple ("busy"), others green.
      c.className = 'cnt' + (pj.id === p.activeId ? ' busy' : '')
      c.textContent = String(n)
      d.appendChild(c)
    }
    d.onclick = () => p.onSelect(pj.id)
    el.appendChild(d)
  }

  const sp = document.createElement('div')
  sp.className = 'sp'
  el.appendChild(sp)

  const add = document.createElement('div')
  add.className = 'add'
  add.textContent = '＋'
  add.title = 'Add project from GitHub'
  add.onclick = p.onAdd
  el.appendChild(add)

  return el
}
