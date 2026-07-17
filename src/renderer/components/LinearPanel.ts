// Linear integration UI (S2). A pure, callback-driven component: link a project,
// pull issues, and write back state/comments with an explicit PREVIEW modal
// before any remote mutation. ALL user/remote text is rendered via textContent
// (never innerHTML) so Linear-sourced strings can never inject markup (C-14).

import type { LinearLink } from '@shared/types'

export interface LinearStatus {
  connected: boolean
  link?: LinearLink
  account?: string
}

/** A backlog row surfaced for write-back (linear-owned rows only). */
export interface LinearBacklogRow {
  id: string
  title: string
  remoteStatus?: string | null
  linearUrl?: string | null
}

/** The preview envelope returned by the main process before a write-back. */
export interface WritebackPreview {
  itemId: string
  identifier: string
  title: string
  action: 'started' | 'done' | 'comment'
  target: string
  alreadySatisfied: boolean
}

export interface LinearPanelProps {
  status: LinearStatus
  /** Linear-owned backlog rows for the current project (write-back targets). */
  rows: LinearBacklogRow[]
  /** Link the current project (opens the OAuth flow in the browser). */
  onLink: () => void
  /** Pull issues into the backlog. */
  onPull: () => void
  /** Disconnect the linked account (revoke + remove token). */
  onLogout: (accountId: string) => void
  /** Request a preview for a write-back (no mutation). Resolves the preview or an error. */
  onPreview: (itemId: string, action: WritebackActionInput) => Promise<WritebackPreview | { error: string }>
  /** Apply a previewed write-back. Resolves a result envelope. */
  onApply: (itemId: string, action: WritebackActionInput) => Promise<{ ok?: boolean; outcome?: string; error?: string }>
  onCancel: () => void
}

export type WritebackActionInput =
  | { kind: 'started' }
  | { kind: 'done' }
  | { kind: 'comment'; text: string }

/** Build the Linear panel overlay. Returns the root element. */
export function LinearPanel(p: LinearPanelProps): HTMLElement {
  const wrap = el('div', 'modal-wrap show')
  wrap.onclick = (e) => { if (e.target === wrap) p.onCancel() }

  const modal = el('div', 'modal')
  modal.style.width = '560px'

  const h3 = el('h3')
  h3.textContent = '🔗 Linear'
  modal.appendChild(h3)

  const sub = el('div', 'sub')
  modal.appendChild(sub)

  // --- connection / actions row ---
  const actions = el('div', 'linear-actions')
  actions.style.display = 'flex'
  actions.style.gap = '8px'
  actions.style.padding = '0 18px 10px'

  const linkBtn = button(p.status.connected ? 'Re-link project' : 'Connect & link', 'primary linear-link')
  linkBtn.onclick = p.onLink

  const pullBtn = button('Pull issues', 'linear-pull')
  pullBtn.disabled = !p.status.connected
  pullBtn.title = p.status.connected ? '' : 'Link the project first'
  pullBtn.onclick = p.onPull

  actions.append(linkBtn, pullBtn)

  if (p.status.connected && p.status.account) {
    const out = button('Disconnect', 'danger linear-logout')
    out.onclick = () => p.onLogout(p.status.account!)
    actions.appendChild(out)
  }
  modal.appendChild(actions)

  if (p.status.connected && p.status.link) {
    sub.textContent = `Linked to ${p.status.link.label}. Pull issues into the backlog, or write back state and comments.`
  } else {
    sub.textContent = 'Connect your Linear account to pull issues into this project and write status/comments back.'
  }

  // --- issue rows (write-back targets) ---
  const scroll = el('div', 'mscroll linear-rows')
  modal.appendChild(scroll)

  const renderRows = () => {
    scroll.replaceChildren()
    if (!p.status.connected) return
    if (p.rows.length === 0) {
      const empty = el('div', 'lib-empty')
      empty.textContent = 'No Linear issues pulled yet. Click "Pull issues".'
      scroll.appendChild(empty)
      return
    }
    for (const row of p.rows) {
      scroll.appendChild(rowEl(row, p))
    }
  }
  renderRows()

  const foot = el('div', 'foot')
  const close = button('Close')
  close.onclick = p.onCancel
  foot.appendChild(close)
  modal.appendChild(foot)

  wrap.appendChild(modal)
  return wrap
}

/** One issue row with its three write-back actions. */
function rowEl(row: LinearBacklogRow, p: LinearPanelProps): HTMLElement {
  const opt = el('div', 'mopt linear-row')
  const ti = el('div', 'ti')
  const b = document.createElement('b')
  b.textContent = row.title
  const span = document.createElement('span')
  span.textContent = row.remoteStatus ? `Linear: ${row.remoteStatus}` : 'Linear issue'
  ti.append(b, span)

  const acts = el('div', 'linear-row-actions')
  acts.style.display = 'flex'
  acts.style.gap = '6px'
  const started = button('Mark started', 'wb-started')
  started.onclick = (e) => { e.stopPropagation(); void openPreview(row, { kind: 'started' }, p) }
  const done = button('Mark done', 'wb-done')
  done.onclick = (e) => { e.stopPropagation(); void openPreview(row, { kind: 'done' }, p) }
  const comment = button('Comment', 'wb-comment')
  comment.onclick = (e) => { e.stopPropagation(); void openComment(row, p) }
  acts.append(started, done, comment)

  opt.append(ti, acts)
  return opt
}

/** Prompt for comment text, then open the shared preview modal. */
function openComment(row: LinearBacklogRow, p: LinearPanelProps): void {
  const overlay = el('div', 'modal-wrap show linear-comment-prompt')
  const modal = el('div', 'modal')
  modal.style.width = '440px'
  const h = el('h3'); h.textContent = `Comment on ${row.title}`
  const body = el('div'); body.style.padding = '4px 18px 14px'
  const input = document.createElement('textarea')
  input.className = 'linear-comment-input'
  input.rows = 4
  input.style.width = '100%'
  input.placeholder = 'Comment text…'
  body.appendChild(input)
  const foot = el('div', 'foot')
  const cancel = button('Cancel'); cancel.onclick = () => overlay.remove()
  const next = button('Preview', 'primary')
  next.onclick = () => {
    const text = input.value.trim()
    if (!text) return
    overlay.remove()
    void openPreview(row, { kind: 'comment', text }, p)
  }
  foot.append(cancel, next)
  modal.append(h, body, foot)
  overlay.append(modal)
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove() }
  document.body.appendChild(overlay)
  queueMicrotask(() => input.focus())
}

/** The mandatory PREVIEW modal: shows the EXACT target/comment before applying. */
async function openPreview(row: LinearBacklogRow, action: WritebackActionInput, p: LinearPanelProps): Promise<void> {
  const preview = await p.onPreview(row.id, action)
  if ('error' in preview) { toast(`Preview failed: ${preview.error}`); return }

  const overlay = el('div', 'modal-wrap show linear-preview')
  const modal = el('div', 'modal')
  modal.style.width = '480px'
  const h = el('h3'); h.textContent = 'Confirm write-back to Linear'
  modal.appendChild(h)

  const detail = el('div', 'linear-preview-detail')
  detail.style.padding = '4px 18px 8px'

  const lines: Array<[string, string]> = [
    ['Issue', `${preview.identifier} — ${preview.title}`],
    ['Action', labelFor(preview.action)]
  ]
  if (preview.action === 'comment') lines.push(['Comment', preview.target])
  else lines.push(['Target state', preview.target])

  for (const [k, v] of lines) {
    const rowEl2 = el('div', 'linear-preview-line')
    const key = document.createElement('b'); key.textContent = `${k}: `
    const val = document.createElement('span'); val.textContent = v
    rowEl2.append(key, val)
    detail.appendChild(rowEl2)
  }
  modal.appendChild(detail)

  if (preview.alreadySatisfied) {
    const note = el('div', 'linear-preview-noop sub')
    note.textContent = 'Already in this state remotely — applying will be a no-op.'
    modal.appendChild(note)
  }

  const foot = el('div', 'foot')
  const cancel = button('Cancel'); cancel.onclick = () => overlay.remove()
  const confirm = button('Apply', 'primary linear-apply')
  confirm.onclick = async () => {
    confirm.disabled = true
    const res = await p.onApply(row.id, action)
    overlay.remove()
    if (res.error) toast(`Write-back failed: ${res.error}`)
    else if (res.outcome === 'noop') toast('No change needed (already applied).')
    else toast('Written back to Linear.')
  }
  foot.append(cancel, confirm)
  modal.appendChild(foot)

  overlay.appendChild(modal)
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove() }
  document.body.appendChild(overlay)
}

function labelFor(kind: 'started' | 'done' | 'comment'): string {
  return kind === 'started' ? 'Mark issue started' : kind === 'done' ? 'Mark issue done' : 'Add comment'
}

// --- tiny DOM helpers (textContent-only) ---
function el(tag: string, cls?: string): HTMLElement {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  return e
}

function button(label: string, cls?: string): HTMLButtonElement {
  const b = document.createElement('button')
  b.textContent = label
  if (cls) b.className = cls
  return b
}

/** Non-blocking toast (self-contained so the component has no import coupling). */
function toast(message: string, ms = 2600): void {
  document.getElementById('linear-toast')?.remove()
  const t = el('div', 'flash')
  t.id = 'linear-toast'
  t.textContent = message
  document.body.appendChild(t)
  setTimeout(() => t.remove(), ms)
}
