import type { BacklogItem, BacklogKind, BacklogCreateInput, BacklogUpdateInput } from '@shared/types'

// Create/edit modal for a manual backlog item (S1). Follows the returned-overlay
// pattern (.modal-wrap.show > .modal): main.ts assigns #picker-overlay and
// appends to body; closeOverlay() removes it. All values are read from inputs and
// handed back via callbacks — the component never calls the bridge directly.

const KINDS: BacklogKind[] = ['epic', 'goal', 'task', 'ticket']

// Which parent kinds may contain a given child (mirrors Store.canNest / C-8).
function canNest(parentKind: BacklogKind, childKind: BacklogKind): boolean {
  if (parentKind === 'epic') return childKind === 'goal' || childKind === 'task' || childKind === 'ticket'
  if (parentKind === 'goal') return childKind === 'task' || childKind === 'ticket'
  return false // task/ticket are leaves
}

export interface BacklogModalProps {
  /** Existing item to edit, or undefined to create. Generated/linear items are
   *  never passed here (they're read-only). */
  item?: BacklogItem
  /** Sibling items in the project — candidate parents (excludes self + descendants). */
  items: BacklogItem[]
  onCreate: (input: BacklogCreateInput) => void
  onUpdate: (input: BacklogUpdateInput) => void
  onCancel: () => void
}

/** Would setting `parentId` as the parent of `id` create a cycle? (walk-up) */
function wouldCycle(items: BacklogItem[], id: string, parentId: string): boolean {
  const byId = new Map(items.map((i) => [i.id, i]))
  let cur: string | null | undefined = parentId
  const seen = new Set<string>()
  while (cur) {
    if (cur === id) return true
    if (seen.has(cur)) return true
    seen.add(cur)
    cur = byId.get(cur)?.parentId ?? null
  }
  return false
}

export function BacklogModal(p: BacklogModalProps): HTMLElement {
  const editing = !!p.item
  const wrap = document.createElement('div')
  wrap.className = 'modal-wrap show'
  const modal = document.createElement('div')
  modal.className = 'modal bk-modal'
  modal.style.width = '520px'

  const h3 = document.createElement('h3')
  h3.textContent = editing ? 'Edit backlog item' : 'New backlog item'
  modal.appendChild(h3)

  const body = document.createElement('div')
  body.className = 'bk-modal-body'

  // --- kind (fixed when editing: kind is immutable through the generic path) ---
  let kind: BacklogKind = p.item?.kind ?? 'task'
  const kindRow = document.createElement('label')
  kindRow.className = 'bk-field'
  const kindLabel = document.createElement('span')
  kindLabel.textContent = 'Kind'
  kindRow.appendChild(kindLabel)
  const kindSel = document.createElement('select')
  kindSel.className = 'bk-input'
  for (const k of KINDS) {
    const o = document.createElement('option')
    o.value = k
    o.textContent = k
    if (k === kind) o.selected = true
    kindSel.appendChild(o)
  }
  kindSel.disabled = editing
  kindRow.appendChild(kindSel)
  body.appendChild(kindRow)

  // --- title ---
  const titleRow = document.createElement('label')
  titleRow.className = 'bk-field'
  const titleLabel = document.createElement('span')
  titleLabel.textContent = 'Title'
  const title = document.createElement('input')
  title.type = 'text'
  title.className = 'bk-input'
  title.placeholder = 'Short title'
  title.value = p.item?.title ?? ''
  titleRow.append(titleLabel, title)
  body.appendChild(titleRow)

  // --- parent selector ---
  const parentRow = document.createElement('label')
  parentRow.className = 'bk-field'
  const parentLabel = document.createElement('span')
  parentLabel.textContent = 'Parent'
  const parentSel = document.createElement('select')
  parentSel.className = 'bk-input'
  parentRow.append(parentLabel, parentSel)
  body.appendChild(parentRow)

  // Rebuild the parent options whenever the child kind changes (nesting rules).
  const rebuildParents = () => {
    parentSel.replaceChildren()
    const none = document.createElement('option')
    none.value = ''
    none.textContent = '— none (top level) —'
    parentSel.appendChild(none)
    for (const cand of p.items) {
      if (p.item && cand.id === p.item.id) continue // never self
      if (cand.source === 'generated' || cand.source === 'linear') continue
      if (!canNest(cand.kind, kind)) continue
      if (p.item && wouldCycle(p.items, p.item.id, cand.id)) continue
      const o = document.createElement('option')
      o.value = cand.id
      o.textContent = `${cand.kind}: ${cand.title}`
      if (p.item?.parentId === cand.id) o.selected = true
      parentSel.appendChild(o)
    }
  }
  rebuildParents()
  kindSel.onchange = () => {
    kind = kindSel.value as BacklogKind
    rebuildParents()
  }

  // --- body markdown ---
  const bodyRow = document.createElement('label')
  bodyRow.className = 'bk-field'
  const bodyLabel = document.createElement('span')
  bodyLabel.textContent = 'Body (markdown)'
  const bodyMd = document.createElement('textarea')
  bodyMd.className = 'bk-input bk-textarea'
  bodyMd.rows = 6
  bodyMd.placeholder = 'Describe the work…'
  bodyMd.value = p.item?.bodyMd ?? ''
  bodyRow.append(bodyLabel, bodyMd)
  body.appendChild(bodyRow)

  modal.appendChild(body)

  // --- error line + footer ---
  const err = document.createElement('div')
  err.className = 'bk-modal-err'
  modal.appendChild(err)

  const foot = document.createElement('div')
  foot.className = 'foot'
  const cancel = document.createElement('button')
  cancel.textContent = 'Cancel'
  cancel.onclick = () => p.onCancel()
  const save = document.createElement('button')
  save.className = 'primary'
  save.textContent = editing ? 'Save' : 'Create'
  save.onclick = () => {
    const t = title.value.trim()
    if (!t) {
      err.textContent = 'Title is required.'
      return
    }
    const parentId = parentSel.value || null
    if (editing && p.item) {
      p.onUpdate({ id: p.item.id, title: t, bodyMd: bodyMd.value, parentId })
    } else {
      p.onCreate({ projectId: '', kind, title: t, bodyMd: bodyMd.value, parentId })
    }
  }
  foot.append(cancel, save)
  modal.appendChild(foot)

  wrap.appendChild(modal)
  wrap.onclick = (e) => {
    if (e.target === wrap) p.onCancel()
  }
  setTimeout(() => title.focus(), 0)
  return wrap
}
