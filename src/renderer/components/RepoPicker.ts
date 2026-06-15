export interface RepoPickerProps {
  repos: { repo: string; name: string }[]
  onPick: (repo: string) => void
  onCancel: () => void
}

/** Modal listing the user's GitHub repos to add as a project (reuses .modal styles). */
export function RepoPicker(p: RepoPickerProps): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'modal-wrap show'
  wrap.onclick = (e) => { if (e.target === wrap) p.onCancel() }

  const modal = document.createElement('div')
  modal.className = 'modal'

  const h3 = document.createElement('h3')
  h3.textContent = 'Add project from GitHub'
  modal.appendChild(h3)

  const sub = document.createElement('div')
  sub.className = 'sub'
  sub.textContent = p.repos.length
    ? 'Pick a repo to clone into ~/AgentIDE and open as a project.'
    : 'No repos found (is `gh` authenticated?).'
  modal.appendChild(sub)

  const scroll = document.createElement('div')
  scroll.className = 'mscroll'
  for (const r of p.repos) {
    const opt = document.createElement('div')
    opt.className = 'mopt'
    opt.onclick = () => p.onPick(r.repo)
    const ti = document.createElement('div')
    ti.className = 'ti'
    const b = document.createElement('b')
    b.textContent = r.name
    const span = document.createElement('span')
    span.textContent = r.repo
    ti.append(b, span)
    opt.appendChild(ti)
    scroll.appendChild(opt)
  }
  modal.appendChild(scroll)

  const foot = document.createElement('div')
  foot.className = 'foot'
  const cancel = document.createElement('button')
  cancel.textContent = 'Cancel'
  cancel.onclick = p.onCancel
  foot.appendChild(cancel)
  modal.appendChild(foot)

  wrap.appendChild(modal)
  return wrap
}
