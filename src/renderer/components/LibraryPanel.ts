import type { LibraryCategory, LibraryItem } from '@shared/types'

const TITLE: Record<LibraryCategory, string> = { prompts: 'Prompts', skills: 'Skills', workflows: 'Workflows' }
const ICON: Record<LibraryCategory, string> = { prompts: '📌', skills: '🧠', workflows: '⚙' }

export interface LibraryPanelProps {
  category: LibraryCategory
  items: LibraryItem[]
  /** Whether a session is active to insert into (enables the primary action). */
  hasActiveSession: boolean
  /** Primary action for a Prompt: insert its body into the active session. */
  onUse: (item: LibraryItem) => void
  onCancel: () => void
}

/** Modal: a filterable list of one library category (D14). Search narrows by
 *  name + description. Prompts offer "Insert into session"; skills/workflows show
 *  a hint of how to invoke them in the active CLI (they live in the mounted
 *  library so the CLI can run them). Returns the overlay element. */
export function LibraryPanel(p: LibraryPanelProps): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'modal-wrap show'
  wrap.onclick = (e) => { if (e.target === wrap) p.onCancel() }

  const modal = document.createElement('div')
  modal.className = 'modal'

  const h3 = document.createElement('h3')
  h3.textContent = `${ICON[p.category]} ${TITLE[p.category]}`
  modal.appendChild(h3)

  const sub = document.createElement('div')
  sub.className = 'sub'
  sub.textContent = p.category === 'prompts'
    ? 'Click a prompt to insert it into the active session.'
    : `Pick a ${p.category === 'skills' ? 'skill' : 'workflow'} to insert its invocation into the active session.`
  modal.appendChild(sub)

  const search = document.createElement('input')
  search.className = 'lib-search'
  search.type = 'text'
  search.placeholder = `Filter ${TITLE[p.category].toLowerCase()}…`
  modal.appendChild(search)

  const scroll = document.createElement('div')
  scroll.className = 'mscroll'
  modal.appendChild(scroll)

  const empty = document.createElement('div')
  empty.className = 'lib-empty'

  const render = (filter: string) => {
    scroll.innerHTML = ''
    const q = filter.trim().toLowerCase()
    const matches = p.items.filter(
      (it) => !q || it.name.toLowerCase().includes(q) || it.description.toLowerCase().includes(q)
    )
    if (matches.length === 0) {
      empty.textContent = p.items.length === 0
        ? `No ${TITLE[p.category].toLowerCase()} in the library yet. Sync the library to fetch them.`
        : 'No matches.'
      scroll.appendChild(empty)
      return
    }
    for (const it of matches) {
      const opt = document.createElement('div')
      opt.className = 'mopt'
      const ti = document.createElement('div')
      ti.className = 'ti'
      const b = document.createElement('b')
      b.textContent = it.name
      const span = document.createElement('span')
      span.textContent = it.description || it.relPath
      ti.append(b, span)
      const action = document.createElement('button')
      action.className = 'lib-use'
      action.textContent = p.category === 'prompts' ? 'Insert' : 'Use'
      action.disabled = !p.hasActiveSession
      action.title = p.hasActiveSession ? '' : 'Open or launch a session first'
      action.onclick = (e) => { e.stopPropagation(); p.onUse(it) }
      opt.append(ti, action)
      // Clicking the row (not just the button) also inserts, when enabled.
      if (p.hasActiveSession) opt.onclick = () => p.onUse(it)
      scroll.appendChild(opt)
    }
  }
  render('')
  search.oninput = () => render(search.value)

  const foot = document.createElement('div')
  foot.className = 'foot'
  const cancel = document.createElement('button')
  cancel.textContent = 'Close'
  cancel.onclick = p.onCancel
  foot.appendChild(cancel)
  modal.appendChild(foot)

  wrap.appendChild(modal)
  queueMicrotask(() => search.focus())
  return wrap
}
