import type { BacklogItem, BacklogEffectiveStatus, BacklogManualStatus } from '@shared/types'
import { showMenu } from '../ui'

// S1 Backlog tab: bento-box card grid ⇄ table view (toggle persisted in
// localStorage), hierarchy grouping (epics group their children), manualStatus
// moves, and read-only generated/linear rows. All item text is rendered via
// textContent — never innerHTML (C-14 / R2-6).

export type BacklogLayout = 'grid' | 'table'

export interface BacklogViewProps {
  projectName: string
  items: BacklogItem[]
  layout: BacklogLayout
  /** Currently selected item ids for "Work on this". */
  selected: Set<string>
  onToggleLayout: (next: BacklogLayout) => void
  onNew: () => void
  onEdit: (item: BacklogItem) => void
  onDelete: (item: BacklogItem) => void
  onSetStatus: (item: BacklogItem, status: BacklogManualStatus) => void
  onToggleSelect: (item: BacklogItem) => void
  onWorkOnThis: () => void
  /** S7 ⌘K navigation target: highlight/scroll to this item id when set. */
  focusId?: string | null
}

/** Effective display status (R34): done-by-ticket > in-session > manualStatus.
 *  Kept in the renderer (Store's helper is main-only) — same precedence. */
export function effectiveStatusOf(
  i: Pick<BacklogItem, 'manualStatus' | 'sessionState'>
): BacklogEffectiveStatus {
  if (i.sessionState === 'done-by-ticket') return 'done'
  if (i.sessionState === 'in-session') return 'in-session'
  return i.manualStatus
}

/** Generated + linear rows are read-only in the UI (main refuses edits too). */
export function isReadOnly(i: BacklogItem): boolean {
  return i.source === 'generated' || i.source === 'linear'
}

const KIND_ICON: Record<BacklogItem['kind'], string> = { epic: '🗂', goal: '🎯', task: '⬡', ticket: '🎫' }

function statusBadge(item: BacklogItem): HTMLElement {
  const eff = effectiveStatusOf(item)
  const b = document.createElement('span')
  b.className = `bk-status ${eff}`
  // Linear-sourced rows show the remote state unless locally completed (R5/R34).
  b.textContent = item.source === 'linear' && eff !== 'done' && item.remoteStatus ? item.remoteStatus : eff
  return b
}

/** Order items so each epic/goal is immediately followed by its descendants
 *  (depth-first), roots by createdAt. Returns [item, depth] pairs. */
function hierarchize(items: BacklogItem[]): { item: BacklogItem; depth: number }[] {
  const byParent = new Map<string | null, BacklogItem[]>()
  for (const i of items) {
    const key = i.parentId ?? null
    ;(byParent.get(key) ?? byParent.set(key, []).get(key)!).push(i)
  }
  const ids = new Set(items.map((i) => i.id))
  const out: { item: BacklogItem; depth: number }[] = []
  const walk = (parent: string | null, depth: number) => {
    const kids = (byParent.get(parent) ?? []).sort((a, b) => a.createdAt - b.createdAt)
    for (const k of kids) {
      out.push({ item: k, depth })
      walk(k.id, depth + 1)
    }
  }
  // Roots = items whose parent is null OR whose parent isn't in this project set
  // (orphans surface at top level rather than vanishing).
  walk(null, 0)
  for (const i of items) {
    if (i.parentId && !ids.has(i.parentId) && !out.some((o) => o.item.id === i.id)) {
      out.push({ item: i, depth: 0 })
      walk(i.id, 1)
    }
  }
  return out
}

function itemMenuButton(item: BacklogViewProps, it: BacklogItem): HTMLElement {
  const dots = document.createElement('button')
  dots.className = 'bk-dots'
  dots.textContent = '⋯'
  dots.title = 'Actions'
  const ro = isReadOnly(it)
  dots.onclick = (e) => {
    e.stopPropagation()
    const r = dots.getBoundingClientRect()
    const moves: { label: string; s: BacklogManualStatus }[] = [
      { label: 'Move to Icebox', s: 'icebox' },
      { label: 'Move to Planned', s: 'planned' },
      { label: 'Mark Done', s: 'done' }
    ]
    showMenu(r.left, r.bottom, [
      { label: 'Edit…', onClick: () => item.onEdit(it), disabled: ro },
      ...moves.map((m) => ({
        label: m.label,
        onClick: () => item.onSetStatus(it, m.s),
        disabled: ro || it.manualStatus === m.s
      })),
      { label: 'Delete', danger: true, onClick: () => item.onDelete(it), disabled: ro }
    ])
  }
  return dots
}

function selectBox(p: BacklogViewProps, it: BacklogItem): HTMLElement {
  const box = document.createElement('input')
  box.type = 'checkbox'
  box.className = 'bk-select'
  box.checked = p.selected.has(it.id)
  box.title = 'Select for "Work on this"'
  box.onclick = (e) => e.stopPropagation()
  box.onchange = () => p.onToggleSelect(it)
  return box
}

function card(p: BacklogViewProps, it: BacklogItem): HTMLElement {
  const c = document.createElement('div')
  c.className =
    `bk-card kind-${it.kind}` + (isReadOnly(it) ? ' readonly' : '') + (p.selected.has(it.id) ? ' sel' : '')
  c.dataset.id = it.id
  c.dataset.kind = it.kind

  const head = document.createElement('div')
  head.className = 'bk-card-head'
  const kind = document.createElement('span')
  kind.className = 'bk-kind'
  kind.textContent = `${KIND_ICON[it.kind]} ${it.kind}`
  head.append(selectBox(p, it), kind, statusBadge(it), itemMenuButton(p, it))
  c.appendChild(head)

  const title = document.createElement('div')
  title.className = 'bk-title'
  title.textContent = it.title
  c.appendChild(title)

  if (it.bodyMd) {
    const body = document.createElement('div')
    body.className = 'bk-body'
    body.textContent = it.bodyMd
    c.appendChild(body)
  }
  if (isReadOnly(it)) {
    const lock = document.createElement('span')
    lock.className = 'bk-lock'
    lock.textContent = it.source === 'linear' ? '🔗 linear (read-only)' : '🔒 generated (read-only)'
    c.appendChild(lock)
  }
  return c
}

function tableRow(p: BacklogViewProps, it: BacklogItem, depth: number): HTMLElement {
  const row = document.createElement('div')
  row.className =
    `bk-row kind-${it.kind}` + (isReadOnly(it) ? ' readonly' : '') + (p.selected.has(it.id) ? ' sel' : '')
  row.dataset.id = it.id
  row.dataset.kind = it.kind

  const sel = document.createElement('span')
  sel.className = 'bk-c sel'
  sel.appendChild(selectBox(p, it))
  const kind = document.createElement('span')
  kind.className = 'bk-c kind'
  kind.style.paddingLeft = `${depth * 18}px`
  kind.textContent = `${KIND_ICON[it.kind]} ${it.kind}`
  const title = document.createElement('span')
  title.className = 'bk-c title'
  title.textContent = it.title
  const status = document.createElement('span')
  status.className = 'bk-c status'
  status.appendChild(statusBadge(it))
  const act = document.createElement('span')
  act.className = 'bk-c act'
  act.appendChild(itemMenuButton(p, it))
  row.append(sel, kind, title, status, act)
  return row
}

export function BacklogView(p: BacklogViewProps): HTMLElement {
  const el = document.createElement('div')
  el.className = 'backlog-view'

  // ---- header: title, layout toggle, New, Work-on-this ----
  const header = document.createElement('div')
  header.className = 'bk-header'
  const h2 = document.createElement('h2')
  h2.textContent = 'Backlog'
  const sub = document.createElement('span')
  sub.className = 'sub'
  sub.textContent = p.projectName
  header.append(h2, sub)

  const spacer = document.createElement('div')
  spacer.className = 'bk-spacer'
  header.appendChild(spacer)

  if (p.selected.size > 0) {
    const work = document.createElement('button')
    work.className = 'bk-work primary'
    work.textContent = `Work on this (${p.selected.size})`
    work.onclick = () => p.onWorkOnThis()
    header.appendChild(work)
  }

  const toggle = document.createElement('div')
  toggle.className = 'bk-toggle'
  for (const layout of ['grid', 'table'] as const) {
    const b = document.createElement('button')
    b.className = 'bk-tg' + (p.layout === layout ? ' on' : '')
    b.dataset.layout = layout
    b.textContent = layout === 'grid' ? '▦ Cards' : '☰ Table'
    b.onclick = () => p.onToggleLayout(layout)
    toggle.appendChild(b)
  }
  header.appendChild(toggle)

  const add = document.createElement('button')
  add.className = 'bk-new primary'
  add.textContent = '+ New'
  add.onclick = () => p.onNew()
  header.appendChild(add)
  el.appendChild(header)

  // ---- body ----
  if (p.items.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'bk-empty'
    empty.textContent = 'No backlog items yet. Create one, or drop a markdown file into backlog/inbox/.'
    el.appendChild(empty)
    return el
  }

  const ordered = hierarchize(p.items)

  if (p.layout === 'table') {
    const table = document.createElement('div')
    table.className = 'bk-table'
    const head = document.createElement('div')
    head.className = 'bk-row head'
    for (const [cls, label] of [
      ['sel', ''],
      ['kind', 'Kind'],
      ['title', 'Title'],
      ['status', 'Status'],
      ['act', '']
    ] as const) {
      const c = document.createElement('span')
      c.className = `bk-c ${cls}`
      c.textContent = label
      head.appendChild(c)
    }
    table.appendChild(head)
    for (const { item, depth } of ordered) table.appendChild(tableRow(p, item, depth))
    el.appendChild(table)
  } else {
    // Bento grid: group top-level epics/goals with their descendants; leaves at
    // root render as standalone cards.
    const grid = document.createElement('div')
    grid.className = 'bk-grid'
    const roots = ordered.filter(({ depth }) => depth === 0)
    for (const { item } of roots) {
      const childItems = ordered.filter(({ item: c }) => c.parentId === item.id)
      if ((item.kind === 'epic' || item.kind === 'goal') && childItems.length) {
        const groupEl = document.createElement('div')
        groupEl.className = `bk-group kind-${item.kind}`
        groupEl.appendChild(card(p, item))
        const kids = document.createElement('div')
        kids.className = 'bk-kids'
        for (const { item: c } of childItems) kids.appendChild(card(p, c))
        groupEl.appendChild(kids)
        grid.appendChild(groupEl)
      } else {
        grid.appendChild(card(p, item))
      }
    }
    el.appendChild(grid)
  }

  // S7 ⌘K navigation: highlight and scroll to the routed item, if present.
  if (p.focusId) {
    queueMicrotask(() => {
      const target = el.querySelector(`[data-id="${CSS.escape(p.focusId!)}"]`) as HTMLElement | null
      if (target) {
        target.classList.add('bk-focused')
        target.scrollIntoView?.({ block: 'center' })
      }
    })
  }

  return el
}
