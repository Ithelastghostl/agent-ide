import type { Project, GitStatusSummary } from '@shared/types'

export interface RailProps {
  projects: Project[]
  activeId: string | null
  counts: Record<string, number>
  /** S4 git awareness: per-project branch + dirty-count summary (absent for
   *  non-repos / not-yet-loaded). Drives the rail's branch badge. */
  gitStatus?: Record<string, GitStatusSummary>
  onSelect: (id: string) => void
  onHome: () => void
  onAdd: () => void
}

/** Short label for a project's git state: branch name (or "detached" for a
 *  detached HEAD), suffixed with a "●N" dirty marker when the tree is dirty. */
export function gitBadgeLabel(g: GitStatusSummary): string {
  const branch = g.branch === '(detached)' ? 'detached' : g.branch
  return g.dirtyCount > 0 ? `${branch} ●${g.dirtyCount}` : branch
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
    // S4: branch + dirty-count badge under the avatar (read-only git awareness).
    const g = p.gitStatus?.[pj.id]
    if (g && g.branch) {
      const gb = document.createElement('span')
      gb.className = 'gitbadge' + (g.dirtyCount > 0 ? ' dirty' : '')
      gb.textContent = gitBadgeLabel(g)
      gb.title = `git: ${gitBadgeLabel(g)}` +
        (g.ahead || g.behind ? ` (↑${g.ahead} ↓${g.behind})` : '')
      d.appendChild(gb)
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
