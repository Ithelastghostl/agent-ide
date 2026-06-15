// Small shared UI primitives: a dropdown menu and a text-prompt modal.
// Used by the add-project menu, the session ⋯ menu, and rename/name flows.

export interface MenuItem {
  label: string
  onClick: () => void
  danger?: boolean
  disabled?: boolean
}

/** Show a context/dropdown menu at (x, y). Closes on outside click. */
export function showMenu(x: number, y: number, items: MenuItem[]): void {
  document.getElementById('app-menu')?.remove()
  const menu = document.createElement('div')
  menu.id = 'app-menu'
  menu.className = 'ctx-menu'
  menu.style.left = `${x}px`
  menu.style.top = `${y}px`

  for (const it of items) {
    const el = document.createElement('div')
    el.className = 'ctx-item' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : '')
    el.textContent = it.label
    if (!it.disabled) el.onclick = () => { menu.remove(); it.onClick() }
    menu.appendChild(el)
  }
  document.body.appendChild(menu)

  // keep it on-screen
  const r = menu.getBoundingClientRect()
  if (r.right > window.innerWidth) menu.style.left = `${window.innerWidth - r.width - 8}px`
  if (r.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - r.height - 8}px`

  // Close on an outside click only — clicks *inside* the menu must reach the
  // item's own handler (a mousedown on the document would otherwise remove the
  // menu before the item's click fires).
  const close = (e: MouseEvent) => {
    if (menu.contains(e.target as Node)) return
    menu.remove()
    document.removeEventListener('mousedown', close)
  }
  setTimeout(() => document.addEventListener('mousedown', close), 0)
}

export interface ChoiceOption<T> { label: string; value: T; primary?: boolean; hint?: string }

/** In-app choice modal with buttons + an optional checkbox. Resolves to the
 *  chosen value (and checkbox state), or null if cancelled. */
export function chooseOption<T>(
  title: string,
  options: ChoiceOption<T>[],
  checkbox?: { label: string; checked?: boolean }
): Promise<{ value: T; checked: boolean } | null> {
  return new Promise((resolve) => {
    const wrap = document.createElement('div')
    wrap.className = 'modal-wrap show'
    const modal = document.createElement('div')
    modal.className = 'modal'
    modal.style.width = '460px'

    const h3 = document.createElement('h3')
    h3.textContent = title
    modal.appendChild(h3)

    let checked = checkbox?.checked ?? false
    if (checkbox) {
      const row = document.createElement('label')
      row.className = 'check-row'
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.checked = checked
      box.onchange = () => { checked = box.checked }
      const span = document.createElement('span')
      span.textContent = checkbox.label
      row.append(box, span)
      modal.appendChild(row)
    }

    const foot = document.createElement('div')
    foot.className = 'foot'
    const done = (v: T | null) => { wrap.remove(); resolve(v === null ? null : { value: v, checked }) }
    const cancel = document.createElement('button')
    cancel.textContent = 'Cancel'
    cancel.onclick = () => done(null)
    foot.appendChild(cancel)
    for (const o of options) {
      const b = document.createElement('button')
      b.textContent = o.label
      if (o.primary) b.className = 'primary'
      if (o.hint) b.title = o.hint
      b.onclick = () => done(o.value)
      foot.appendChild(b)
    }
    modal.appendChild(foot)
    wrap.appendChild(modal)
    wrap.onclick = (e) => { if (e.target === wrap) done(null) }
    document.body.appendChild(wrap)
  })
}

/** In-app text prompt modal. Resolves to the entered string, or null if cancelled. */
export function promptText(title: string, placeholder = ''): Promise<string | null> {
  return new Promise((resolve) => {
    const wrap = document.createElement('div')
    wrap.className = 'modal-wrap show'

    const modal = document.createElement('div')
    modal.className = 'modal'
    modal.style.width = '420px'

    const h3 = document.createElement('h3')
    h3.textContent = title
    modal.appendChild(h3)

    const body = document.createElement('div')
    body.style.padding = '4px 18px 14px'
    const input = document.createElement('input')
    input.type = 'text'
    input.placeholder = placeholder
    input.className = 'prompt-input'
    body.appendChild(input)
    modal.appendChild(body)

    const foot = document.createElement('div')
    foot.className = 'foot'
    const cancel = document.createElement('button')
    cancel.textContent = 'Cancel'
    const ok = document.createElement('button')
    ok.textContent = 'OK'
    ok.className = 'primary'
    foot.append(cancel, ok)
    modal.appendChild(foot)
    wrap.appendChild(modal)
    document.body.appendChild(wrap)

    const done = (val: string | null) => { wrap.remove(); resolve(val) }
    cancel.onclick = () => done(null)
    ok.onclick = () => done(input.value.trim())
    wrap.onclick = (e) => { if (e.target === wrap) done(null) }
    input.onkeydown = (e) => {
      if (e.key === 'Enter') done(input.value.trim())
      if (e.key === 'Escape') done(null)
    }
    setTimeout(() => input.focus(), 0)
  })
}
