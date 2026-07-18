import type { SearchHit } from '@shared/types'

export interface SearchOverlayProps {
  /** Injected search call (window.agentIDE.searchQuery in the app; a stub in tests). */
  searchQuery: (query: string, limit?: number) => Promise<SearchHit[]>
  /** Enter on a transcript hit: activate that project + session. */
  onSelectTranscript: (projectId: string, sessionId: string) => void
  /** Enter on a backlog hit: open the Backlog view focused on that item. */
  onSelectBacklog: (projectId: string, itemId: string) => void
  /** Escape / outside click / after a navigation: tear the overlay down. */
  onClose: () => void
  /** Debounce window for the query input (ms). Small so it feels instant. */
  debounceMs?: number
  /** Result cap passed to searchQuery. */
  limit?: number
}

const KIND_ICON: Record<string, string> = { epic: '🗂', goal: '🎯', task: '☑', ticket: '🎫' }

/** ⌘K search overlay (S7). A single query input over cross-session FTS, with
 *  results grouped into Transcripts / Backlog sections. All hit text is rendered
 *  via textContent only (never innerHTML — provenance safety, C-14). Keyboard:
 *  ↑/↓ move a flat selection across both groups, Enter navigates to the selected
 *  hit, Escape closes. Returns the overlay root element. */
export function SearchOverlay(p: SearchOverlayProps): HTMLElement {
  const debounceMs = p.debounceMs ?? 150
  const limit = p.limit ?? 50

  const wrap = document.createElement('div')
  wrap.className = 'search-overlay modal-wrap show'
  wrap.onclick = (e) => {
    if (e.target === wrap) p.onClose()
  }

  const panel = document.createElement('div')
  panel.className = 'search-panel'

  const input = document.createElement('input')
  input.className = 'search-input'
  input.type = 'text'
  input.placeholder = 'Search transcripts and backlog…'
  input.spellcheck = false
  panel.appendChild(input)

  const results = document.createElement('div')
  results.className = 'search-results'
  panel.appendChild(results)

  const hint = document.createElement('div')
  hint.className = 'search-hint'
  hint.textContent = '↑ ↓ to navigate · ↵ to open · esc to close'
  panel.appendChild(hint)

  wrap.appendChild(panel)

  // Flat, ordered list of the currently-rendered hits (transcripts first, then
  // backlog) with the matching row element — the source of truth for ↑/↓/Enter.
  let hits: SearchHit[] = []
  let rows: HTMLElement[] = []
  let active = 0
  // Guard against out-of-order async responses clobbering a newer query.
  let queryToken = 0

  function highlight() {
    rows.forEach((row, i) => row.classList.toggle('on', i === active))
    // scrollIntoView is unimplemented under jsdom — guard so it can't throw.
    rows[active]?.scrollIntoView?.({ block: 'nearest' })
  }

  function move(delta: number) {
    if (rows.length === 0) return
    active = (active + delta + rows.length) % rows.length
    highlight()
  }

  function activate(i: number) {
    const hit = hits[i]
    if (!hit) return
    if (hit.type === 'transcript') p.onSelectTranscript(hit.projectId, hit.sessionId)
    else p.onSelectBacklog(hit.projectId, hit.itemId)
    p.onClose()
  }

  function section(title: string): HTMLElement {
    const h = document.createElement('div')
    h.className = 'search-group'
    h.textContent = title
    return h
  }

  function transcriptRow(hit: Extract<SearchHit, { type: 'transcript' }>): HTMLElement {
    const row = document.createElement('div')
    row.className = 'search-row transcript'
    const title = document.createElement('div')
    title.className = 'sr-title'
    title.textContent = `Session ${hit.sessionId}`
    const snip = document.createElement('div')
    snip.className = 'sr-snippet'
    snip.textContent = hit.snippet
    row.append(title, snip)
    return row
  }

  function backlogRow(hit: Extract<SearchHit, { type: 'backlog' }>): HTMLElement {
    const row = document.createElement('div')
    row.className = 'search-row backlog'
    const title = document.createElement('div')
    title.className = 'sr-title'
    const icon = document.createElement('span')
    icon.className = 'sr-kind'
    icon.textContent = KIND_ICON[hit.kind] ?? '•'
    const name = document.createElement('span')
    name.className = 'sr-name'
    name.textContent = hit.title
    const badge = document.createElement('span')
    badge.className = 'sr-status'
    badge.textContent = hit.status
    title.append(icon, name, badge)
    const snip = document.createElement('div')
    snip.className = 'sr-snippet'
    snip.textContent = hit.snippet
    row.append(title, snip)
    return row
  }

  function renderResults(all: SearchHit[]) {
    rows = []
    active = 0
    results.replaceChildren()

    if (input.value.trim() === '') {
      hits = []
      return
    }
    if (all.length === 0) {
      hits = []
      const empty = document.createElement('div')
      empty.className = 'search-empty'
      empty.textContent = 'No matches.'
      results.appendChild(empty)
      return
    }

    const transcripts = all.filter(
      (h): h is Extract<SearchHit, { type: 'transcript' }> => h.type === 'transcript'
    )
    const backlog = all.filter((h): h is Extract<SearchHit, { type: 'backlog' }> => h.type === 'backlog')

    // Rebuild `hits` in the exact visual/nav order (transcripts then backlog).
    hits = [...transcripts, ...backlog]

    if (transcripts.length) {
      results.appendChild(section('Transcripts'))
      for (const h of transcripts) {
        const row = transcriptRow(h)
        row.onmouseenter = () => {
          active = rows.indexOf(row)
          highlight()
        }
        row.onclick = () => activate(rows.indexOf(row))
        results.appendChild(row)
        rows.push(row)
      }
    }
    if (backlog.length) {
      results.appendChild(section('Backlog'))
      for (const h of backlog) {
        const row = backlogRow(h)
        row.onmouseenter = () => {
          active = rows.indexOf(row)
          highlight()
        }
        row.onclick = () => activate(rows.indexOf(row))
        results.appendChild(row)
        rows.push(row)
      }
    }
    highlight()
  }

  let timer: ReturnType<typeof setTimeout> | null = null
  function runQuery(q: string) {
    const token = ++queryToken
    if (q.trim() === '') {
      renderResults([])
      return
    }
    // Only the search call's rejection maps to an empty render — a render-time
    // error must surface, not be swallowed as "no matches".
    p.searchQuery(q, limit)
      .then(
        (all) => all,
        () => [] as SearchHit[]
      )
      .then((all) => {
        if (token === queryToken) renderResults(all)
      })
  }

  input.addEventListener('input', () => {
    if (timer) clearTimeout(timer)
    const q = input.value
    timer = setTimeout(() => runQuery(q), debounceMs)
  })

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      move(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      move(-1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      activate(active)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      p.onClose()
    }
  })

  queueMicrotask(() => input.focus())
  return wrap
}
