import type { Provider, Model } from '@shared/types'

const PROVIDER_LABEL: Record<Provider, string> = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini' }
const PROVIDER_VAR: Record<Provider, string> = {
  codex: 'var(--codex)',
  claude: 'var(--claude)',
  gemini: 'var(--gemini)'
}

export interface ModelPickerProps {
  provider: Provider
  models: Model[]
  onPick: (provider: Provider, modelId: string) => void
  onCancel: () => void
}

/** Modal: full model list for a provider (D3). Returns the overlay element. */
export function ModelPicker(p: ModelPickerProps): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'modal-wrap show'
  wrap.onclick = (e) => { if (e.target === wrap) p.onCancel() }

  const modal = document.createElement('div')
  modal.className = 'modal'

  const h3 = document.createElement('h3')
  const pd = document.createElement('span')
  pd.className = 'pd'
  pd.style.background = PROVIDER_VAR[p.provider]
  h3.append(pd, document.createTextNode(`New ${PROVIDER_LABEL[p.provider]} session`))
  modal.appendChild(h3)

  const sub = document.createElement('div')
  sub.className = 'sub'
  sub.textContent = 'Pick the model for this session — full list. Lighter models for trivial edits, heavier for hard work. Changeable later.'
  modal.appendChild(sub)

  const scroll = document.createElement('div')
  scroll.className = 'mscroll'
  for (const m of p.models) {
    const opt = document.createElement('div')
    opt.className = 'mopt'
    opt.onclick = () => p.onPick(p.provider, m.id)
    const ti = document.createElement('div')
    ti.className = 'ti'
    const b = document.createElement('b')
    b.textContent = m.label
    const span = document.createElement('span')
    span.textContent = m.id
    ti.append(b, span)
    const tier = document.createElement('div')
    tier.className = `tier ${m.tier}`
    tier.textContent = m.tier === 'fast' ? 'Fast' : m.tier === 'balanced' ? 'Balanced' : 'Max'
    opt.append(ti, tier)
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
