import { PROVIDERS, type Provider, type Model, type QueueItem, type QueueState } from '@shared/types'

export interface QueueDrawerProps {
  projectName: string
  items: QueueItem[]
  autoAdvance: boolean
  /** Models per provider, for the model dropdown. */
  modelsFor: (p: Provider) => Model[]
  /** Enqueue a new item. `useContainer` defaults to false in the UI. Returns the
   *  main-side result so the drawer can surface a rejection (e.g. the 5-item cap). */
  onEnqueue: (input: {
    provider: Provider
    model: string
    objective: string
    useContainer: boolean
    backlogItemIds: string[]
  }) => Promise<{ item?: QueueItem; error?: string }>
  onDelete: (id: string) => void
  onReorder: (orderedIds: string[]) => void
  onStartNext: () => void
  onToggleAutoAdvance: (on: boolean) => void
  onClose: () => void
}

/** Primer cap: binding more than 5 backlog items per launch is rejected at
 *  selection (R21-minor). Enforced in the UI before enqueue, and again in main. */
export const PRIMER_ITEM_CAP = 5

const STATE_LABEL: Record<QueueState, string> = {
  pending: 'pending',
  launching: 'launching',
  launched: 'launched',
  failed: 'failed'
}

/** The per-project queue drawer (S6): compose a queued session (objective,
 *  provider, model, useContainer, backlog items), list queued items with state
 *  chips + lastError, reorder them, "Start next", and an autoAdvance toggle.
 *  Modeled as a modal overlay (like LibraryPanel). Returns the overlay element. */
export function QueueDrawer(p: QueueDrawerProps): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'modal-wrap show queue-drawer'
  wrap.onclick = (e) => {
    if (e.target === wrap) p.onClose()
  }

  const modal = document.createElement('div')
  modal.className = 'modal queue-modal'

  const h3 = document.createElement('h3')
  h3.textContent = `▷ Session queue · ${p.projectName}`
  modal.appendChild(h3)

  // --- autoAdvance toggle -------------------------------------------------------
  const advRow = document.createElement('label')
  advRow.className = 'q-autoadvance'
  const advCb = document.createElement('input')
  advCb.type = 'checkbox'
  advCb.className = 'q-autoadvance-cb'
  advCb.checked = p.autoAdvance
  advCb.onchange = () => p.onToggleAutoAdvance(advCb.checked)
  const advTxt = document.createElement('span')
  advTxt.textContent = 'Auto-advance — launch the next queued session when one completes'
  advRow.append(advCb, advTxt)
  modal.appendChild(advRow)

  // --- compose form -------------------------------------------------------------
  const form = document.createElement('div')
  form.className = 'q-form'

  const objective = document.createElement('input')
  objective.type = 'text'
  objective.className = 'q-objective'
  objective.placeholder = 'Objective for this session (required)'

  const provider = document.createElement('select')
  provider.className = 'q-provider'
  for (const pr of PROVIDERS) {
    const opt = document.createElement('option')
    opt.value = pr
    opt.textContent = pr
    provider.appendChild(opt)
  }

  const model = document.createElement('select')
  model.className = 'q-model'
  const fillModels = () => {
    model.innerHTML = ''
    for (const m of p.modelsFor(provider.value as Provider)) {
      const opt = document.createElement('option')
      opt.value = m.id
      opt.textContent = m.label
      model.appendChild(opt)
    }
  }
  fillModels()
  provider.onchange = fillModels

  // Backlog item ids — a comma/space list. Kept simple (S1 owns the rich picker);
  // the cap is enforced here so more than 5 is refused before enqueue.
  const backlog = document.createElement('input')
  backlog.type = 'text'
  backlog.className = 'q-backlog'
  backlog.placeholder = 'Backlog item ids to bind (optional, max 5, space/comma separated)'

  // useContainer — DEFAULT FALSE in the UI (task requirement).
  const ucRow = document.createElement('label')
  ucRow.className = 'q-usecontainer'
  const ucCb = document.createElement('input')
  ucCb.type = 'checkbox'
  ucCb.className = 'q-usecontainer-cb'
  ucCb.checked = false
  const ucTxt = document.createElement('span')
  ucTxt.textContent = 'Run in devcontainer'
  ucRow.append(ucCb, ucTxt)

  const err = document.createElement('div')
  err.className = 'q-error'

  const addBtn = document.createElement('button')
  addBtn.className = 'primary q-add'
  addBtn.textContent = 'Add to queue'
  addBtn.onclick = async () => {
    err.textContent = ''
    const obj = objective.value.trim()
    if (!obj) {
      err.textContent = 'Objective is required.'
      return
    }
    const ids = backlog.value
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (ids.length > PRIMER_ITEM_CAP) {
      err.textContent = `At most ${PRIMER_ITEM_CAP} backlog items per launch (got ${ids.length}).`
      return
    }
    addBtn.disabled = true
    const res = await p.onEnqueue({
      provider: provider.value as Provider,
      model: model.value,
      objective: obj,
      useContainer: ucCb.checked,
      backlogItemIds: ids
    })
    addBtn.disabled = false
    if (res.error) {
      err.textContent = res.error
      return
    }
    // reset the objective for a quick next add
    objective.value = ''
    backlog.value = ''
  }

  form.append(objective, provider, model, backlog, ucRow, addBtn, err)
  modal.appendChild(form)

  // --- queued items list --------------------------------------------------------
  const listWrap = document.createElement('div')
  listWrap.className = 'q-list'
  if (p.items.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'q-empty'
    empty.textContent = 'No queued sessions. Add one above.'
    listWrap.appendChild(empty)
  }
  const ordered = [...p.items].sort((a, b) => a.position - b.position)
  ordered.forEach((it, idx) => {
    const row = document.createElement('div')
    row.className = 'q-item'
    row.dataset.id = it.id

    const chip = document.createElement('span')
    chip.className = 'q-chip ' + it.state
    chip.textContent = STATE_LABEL[it.state]
    row.appendChild(chip)

    const body = document.createElement('div')
    body.className = 'q-item-body'
    const title = document.createElement('b')
    title.textContent = it.objective
    const meta = document.createElement('span')
    meta.className = 'q-item-meta'
    meta.textContent = `${it.provider}${it.model ? ' · ' + it.model : ''}${it.backlogItemIds.length ? ' · ' + it.backlogItemIds.length + ' item(s)' : ''}`
    body.append(title, meta)
    if (it.state === 'failed' && it.lastError) {
      const le = document.createElement('span')
      le.className = 'q-item-error'
      le.textContent = it.lastError
      body.appendChild(le)
    }
    row.appendChild(body)

    // reorder up/down — recompute the ordered id list and hand it to onReorder.
    const controls = document.createElement('div')
    controls.className = 'q-item-controls'
    const up = document.createElement('button')
    up.className = 'q-up'
    up.textContent = '↑'
    up.title = 'Move up'
    up.disabled = idx === 0
    up.onclick = () => {
      const ids = ordered.map((x) => x.id)
      ;[ids[idx - 1], ids[idx]] = [ids[idx], ids[idx - 1]]
      p.onReorder(ids)
    }
    const down = document.createElement('button')
    down.className = 'q-down'
    down.textContent = '↓'
    down.title = 'Move down'
    down.disabled = idx === ordered.length - 1
    down.onclick = () => {
      const ids = ordered.map((x) => x.id)
      ;[ids[idx], ids[idx + 1]] = [ids[idx + 1], ids[idx]]
      p.onReorder(ids)
    }
    const del = document.createElement('button')
    del.className = 'q-del'
    del.textContent = '×'
    del.title = 'Remove from queue'
    del.onclick = () => p.onDelete(it.id)
    controls.append(up, down, del)
    row.appendChild(controls)

    listWrap.appendChild(row)
  })
  modal.appendChild(listWrap)

  // --- footer -------------------------------------------------------------------
  const foot = document.createElement('div')
  foot.className = 'foot'
  const startNext = document.createElement('button')
  startNext.className = 'primary q-startnext'
  startNext.textContent = 'Start next'
  startNext.disabled = !p.items.some((it) => it.state === 'pending')
  startNext.title = startNext.disabled ? 'No pending items to start' : 'Launch the next pending session now'
  startNext.onclick = () => p.onStartNext()
  const close = document.createElement('button')
  close.textContent = 'Close'
  close.onclick = p.onClose
  foot.append(startNext, close)
  modal.appendChild(foot)

  wrap.appendChild(modal)
  queueMicrotask(() => objective.focus())
  return wrap
}
