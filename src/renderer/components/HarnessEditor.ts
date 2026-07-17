// S3 (feat/harness-ux): the harness editor modal. Reads/writes the uniform
// Discussion→Playback→Fix protocol (harness:get / harness:set). textContent /
// textarea.value ONLY — the harness body is never rendered as innerHTML (the
// no-innerHTML trust boundary, C-14/R7).

export interface HarnessEditorDeps {
  /** Load the current harness text (harness:get). */
  get: () => Promise<string>
  /** Persist edited harness text (harness:set). */
  set: (text: string) => Promise<{ ok?: true; error?: string }>
}

/** Open the harness editor as an in-app modal. Resolves when it closes. */
export function openHarnessEditor(deps: HarnessEditorDeps): Promise<void> {
  return new Promise((resolve) => {
    const wrap = document.createElement('div')
    wrap.className = 'modal-wrap show harness-modal'
    const modal = document.createElement('div')
    modal.className = 'modal'
    modal.style.width = '680px'

    const h3 = document.createElement('h3')
    h3.textContent = 'Session harness'
    modal.appendChild(h3)

    const sub = document.createElement('div')
    sub.className = 'sub'
    sub.textContent = 'The uniform Discussion → Playback → Fix protocol injected into every session.'
    modal.appendChild(sub)

    const body = document.createElement('div')
    body.className = 'harness-body'
    const area = document.createElement('textarea')
    area.className = 'harness-area'
    area.spellcheck = false
    area.value = 'loading…'
    area.disabled = true
    body.appendChild(area)
    modal.appendChild(body)

    const status = document.createElement('div')
    status.className = 'harness-status'
    modal.appendChild(status)

    const foot = document.createElement('div')
    foot.className = 'foot'
    const cancel = document.createElement('button')
    cancel.textContent = 'Close'
    const save = document.createElement('button')
    save.textContent = 'Save'
    save.className = 'primary'
    save.disabled = true
    foot.append(cancel, save)
    modal.appendChild(foot)

    wrap.appendChild(modal)
    document.body.appendChild(wrap)

    const close = () => { wrap.remove(); resolve() }

    // Load current text. textContent-safe: assigned to textarea.value only.
    deps.get().then((text) => {
      area.value = text
      area.disabled = false
      save.disabled = false
      setTimeout(() => area.focus(), 0)
    }).catch((err) => {
      area.value = ''
      status.className = 'harness-status err'
      status.textContent = `Could not load harness: ${(err as Error).message}`
    })

    save.onclick = async () => {
      save.disabled = true
      status.className = 'harness-status'
      status.textContent = 'saving…'
      try {
        const res = await deps.set(area.value)
        if (res.error) {
          status.className = 'harness-status err'
          status.textContent = `Save failed: ${res.error}`
          save.disabled = false
        } else {
          status.className = 'harness-status ok'
          status.textContent = 'Saved.'
          save.disabled = false
        }
      } catch (err) {
        status.className = 'harness-status err'
        status.textContent = `Save failed: ${(err as Error).message}`
        save.disabled = false
      }
    }

    cancel.onclick = close
    wrap.onclick = (e) => { if (e.target === wrap) close() }
  })
}
