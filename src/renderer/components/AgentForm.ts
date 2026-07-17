import type { AgentInput } from '@shared/types'

export interface AgentFormProps {
  onSubmit: (input: AgentInput) => Promise<{ relPath?: string; error?: string }>
  onDone: () => void
  onCancel: () => void
}

/** Live preview of the filename slug (mirrors main's agentSlug). */
export function previewSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '')
}

/** Modal form for creating a library agent: name + description (frontmatter)
 *  and the three layered sections (Instructions / Data / Context). Errors from
 *  main (bad name, duplicate slug) surface inline. */
export function AgentForm(p: AgentFormProps): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'modal-wrap show'
  wrap.onclick = (e) => { if (e.target === wrap) p.onCancel() }

  const modal = document.createElement('div')
  modal.className = 'modal agent-form'

  const h3 = document.createElement('h3')
  h3.textContent = '🤖 New agent'
  modal.appendChild(h3)

  const sub = document.createElement('div')
  sub.className = 'sub'
  sub.textContent = 'One file, three layers: instructions, data, and context. Saved to the library as agents/<name>.md.'
  modal.appendChild(sub)

  const field = (label: string, el: HTMLInputElement | HTMLTextAreaElement): HTMLElement => {
    const row = document.createElement('label')
    row.className = 'agent-field'
    const cap = document.createElement('span')
    cap.textContent = label
    row.append(cap, el)
    return row
  }

  const name = document.createElement('input')
  name.type = 'text'
  name.placeholder = 'e.g. Release Notes Writer'
  name.className = 'agent-name'
  const slugHint = document.createElement('div')
  slugHint.className = 'sub agent-slug'
  name.oninput = () => {
    const s = previewSlug(name.value)
    slugHint.textContent = s ? `File: agents/${s}.md` : ''
  }

  const description = document.createElement('input')
  description.type = 'text'
  description.placeholder = 'One line: what this agent is for'
  description.className = 'agent-desc'

  const area = (cls: string, placeholder: string): HTMLTextAreaElement => {
    const t = document.createElement('textarea')
    t.className = cls
    t.placeholder = placeholder
    t.rows = 4
    return t
  }
  const instructions = area('agent-instructions', 'How the agent should behave and work')
  const data = area('agent-data', 'Facts, tables, examples the agent needs')
  const context = area('agent-context', 'Background: project, constraints, links')

  const err = document.createElement('div')
  err.className = 'agent-error'

  const scroll = document.createElement('div')
  scroll.className = 'mscroll'
  scroll.append(
    field('Name', name),
    slugHint,
    field('Description', description),
    field('Instructions', instructions),
    field('Data', data),
    field('Context', context),
    err
  )
  modal.appendChild(scroll)

  const foot = document.createElement('div')
  foot.className = 'foot'
  const save = document.createElement('button')
  save.className = 'primary agent-save'
  save.textContent = 'Create'
  save.onclick = async () => {
    save.disabled = true
    err.textContent = ''
    const r = await p.onSubmit({
      name: name.value,
      description: description.value,
      instructions: instructions.value,
      data: data.value,
      context: context.value
    })
    if (r.error) {
      err.textContent = r.error
      save.disabled = false
      return
    }
    p.onDone()
  }
  const cancel = document.createElement('button')
  cancel.textContent = 'Cancel'
  cancel.onclick = p.onCancel
  foot.append(save, cancel)
  modal.appendChild(foot)

  wrap.appendChild(modal)
  queueMicrotask(() => name.focus())
  return wrap
}
