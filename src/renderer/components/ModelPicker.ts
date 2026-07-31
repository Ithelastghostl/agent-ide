import { PROVIDERS, EFFORTS, type Provider, type Model, type Effort } from '@shared/types'

const PROVIDER_LABEL: Record<Provider, string> = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini' }
const PROVIDER_VAR: Record<Provider, string> = {
  codex: 'var(--codex)',
  claude: 'var(--claude)',
  gemini: 'var(--gemini)'
}

export interface ModelPickerProps {
  provider: Provider
  models: Model[]
  onPick: (provider: Provider, modelId: string, effort: Effort | null) => void
  onCancel: () => void
  // ---- S8 agent-preset extensions (all optional; omitting them keeps the
  // classic provider-fixed, model-only picker unchanged) ----
  /** When set, title the picker after the agent this session launches from. */
  agentName?: string
  /** Prefilled, EDITABLE objective (e.g. the agent's description). When present
   *  the picker renders an objective field and the confirm carries its text. */
  objective?: string
  /** Model catalog per provider — enables switching provider inside the picker. */
  modelsForProvider?: (p: Provider) => Model[]
  /** S8 confirm carrying the (possibly edited) objective. Takes precedence over
   *  `onPick` when provided so callers get the prefilled/edited objective back. */
  onLaunch?: (provider: Provider, modelId: string, objective: string, effort: Effort | null) => void
  /** Effort preselected in the row. null → "Default" (no flag; the provider CLI
   *  keeps whatever its own config says). */
  effort?: Effort | null
  /** Set when AGENT_IDE_EFFORT is active. The env var outranks any pick, so the
   *  row locks to that level and says so instead of pretending to be editable. */
  forcedEffort?: Effort | null
}

/** Gemini's CLI has no reasoning-effort concept, so the row is meaningless there. */
function supportsEffort(p: Provider): boolean {
  return p !== 'gemini'
}

/** Modal: full model list for a provider (D3). With S8 props it becomes the
 *  agent-preset launcher — a prefilled editable objective plus provider tabs —
 *  reusing the same overlay chrome. Returns the overlay element. */
export function ModelPicker(p: ModelPickerProps): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'modal-wrap show'
  wrap.onclick = (e) => {
    if (e.target === wrap) p.onCancel()
  }

  const modal = document.createElement('div')
  modal.className = 'modal'

  // Provider is switchable only when a catalog is supplied (agent-preset flow).
  let provider: Provider = p.provider
  const switchable = typeof p.modelsForProvider === 'function'
  const catalog = (prov: Provider): Model[] => (p.modelsForProvider ? p.modelsForProvider(prov) : p.models)

  const h3 = document.createElement('h3')
  const pd = document.createElement('span')
  pd.className = 'pd'
  pd.style.background = PROVIDER_VAR[provider]
  const heading = document.createTextNode(
    p.agentName ? `Launch “${p.agentName}” session` : `New ${PROVIDER_LABEL[provider]} session`
  )
  h3.append(pd, heading)
  modal.appendChild(h3)

  const sub = document.createElement('div')
  sub.className = 'sub'
  sub.textContent = p.agentName
    ? 'Review the objective, pick provider + model — the agent’s instructions are primed automatically.'
    : 'Pick the model for this session — full list. Lighter models for trivial edits, heavier for hard work. Changeable later.'
  modal.appendChild(sub)

  // S8: prefilled, editable objective field.
  let objectiveInput: HTMLTextAreaElement | undefined
  if (p.objective !== undefined) {
    const objLabel = document.createElement('label')
    objLabel.className = 'mp-obj-label'
    objLabel.textContent = 'Objective'
    modal.appendChild(objLabel)
    objectiveInput = document.createElement('textarea')
    objectiveInput.className = 'mp-objective'
    objectiveInput.rows = 2
    objectiveInput.value = p.objective
    modal.appendChild(objectiveInput)
  }

  // Effort row. AGENT_IDE_EFFORT wins over any pick, so when it is set the row
  // is disabled and labelled — the user sees WHY their choice can't move.
  const forced = p.forcedEffort ?? null
  let effort: Effort | null = forced ?? p.effort ?? null
  const effortRow = document.createElement('div')
  effortRow.className = 'mp-effort'
  const effortLabel = document.createElement('span')
  effortLabel.className = 'mp-effort-label'
  effortRow.appendChild(effortLabel)
  const effortBtns = document.createElement('div')
  effortBtns.className = 'mp-effort-btns'
  effortRow.appendChild(effortBtns)

  const renderEffort = () => {
    effortLabel.textContent = forced ? `Effort (set by AGENT_IDE_EFFORT)` : 'Effort'
    effortRow.classList.toggle('locked', !!forced)
    effortRow.hidden = !supportsEffort(provider)
    effortBtns.replaceChildren()
    // null == "Default": send no flag and let the provider CLI's own config
    // decide (e.g. ~/.codex/config.toml model_reasoning_effort).
    for (const level of [null, ...EFFORTS] as (Effort | null)[]) {
      const b = document.createElement('button')
      b.className = 'mp-effort-btn' + (level === effort ? ' on' : '')
      b.textContent = level ?? 'Default'
      b.disabled = !!forced
      b.title = forced
        ? `AGENT_IDE_EFFORT=${forced} overrides the picker`
        : level === null
          ? 'Use the provider CLI’s configured default'
          : `Run this session at ${level} effort`
      b.onclick = () => {
        effort = level
        renderEffort()
      }
      effortBtns.appendChild(b)
    }
  }

  const scroll = document.createElement('div')
  scroll.className = 'mscroll'

  const renderModels = () => {
    scroll.replaceChildren()
    pd.style.background = PROVIDER_VAR[provider]
    for (const m of catalog(provider)) {
      const opt = document.createElement('div')
      opt.className = 'mopt'
      opt.onclick = () => {
        const objective = objectiveInput ? objectiveInput.value : (p.objective ?? '')
        // Gemini takes no effort flag, so never carry a level out for it.
        const chosen = supportsEffort(provider) ? effort : null
        if (p.onLaunch) p.onLaunch(provider, m.id, objective, chosen)
        else p.onPick(provider, m.id, chosen)
      }
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
  }

  // S8: provider tabs (only when a catalog is supplied so we can list models).
  if (switchable) {
    const tabs = document.createElement('div')
    tabs.className = 'mp-provtabs'
    const buttons: { prov: Provider; el: HTMLButtonElement }[] = []
    for (const prov of PROVIDERS) {
      const tab = document.createElement('button')
      tab.className = 'mp-provtab' + (prov === provider ? ' on' : '')
      tab.dataset.provider = prov
      const dot = document.createElement('span')
      dot.className = 'pd'
      dot.style.background = PROVIDER_VAR[prov]
      tab.append(dot, document.createTextNode(PROVIDER_LABEL[prov]))
      tab.onclick = () => {
        provider = prov
        for (const b of buttons) b.el.classList.toggle('on', b.prov === provider)
        renderModels()
        renderEffort() // the row hides for gemini, shows again for the others
      }
      buttons.push({ prov, el: tab })
      tabs.appendChild(tab)
    }
    modal.appendChild(tabs)
  }

  renderEffort()
  modal.appendChild(effortRow)
  renderModels()
  modal.appendChild(scroll)

  const foot = document.createElement('div')
  foot.className = 'foot'
  const cancel = document.createElement('button')
  cancel.textContent = 'Cancel'
  cancel.onclick = p.onCancel
  foot.appendChild(cancel)
  modal.appendChild(foot)

  wrap.appendChild(modal)
  if (objectiveInput) queueMicrotask(() => objectiveInput!.focus())
  return wrap
}
