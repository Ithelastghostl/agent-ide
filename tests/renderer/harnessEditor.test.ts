// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { openHarnessEditor } from '../../src/renderer/components/HarnessEditor'

// A tick helper: the editor loads text via an async get().
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('HarnessEditor modal', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('opens a modal and loads the current harness text into a textarea', async () => {
    openHarnessEditor({ get: async () => '# HARNESS\nhello', set: async () => ({ ok: true }) })
    const area = document.querySelector('.harness-area') as HTMLTextAreaElement
    expect(area).toBeTruthy()
    expect(area.disabled).toBe(true) // disabled until loaded
    await tick()
    expect(area.value).toBe('# HARNESS\nhello')
    expect(area.disabled).toBe(false)
  })

  it('renders harness text via textarea.value only — never innerHTML', async () => {
    const evil = '<img src=x onerror=alert(1)>'
    openHarnessEditor({ get: async () => evil, set: async () => ({ ok: true }) })
    await tick()
    const area = document.querySelector('.harness-area') as HTMLTextAreaElement
    // The payload is the literal textarea value; no element was injected.
    expect(area.value).toBe(evil)
    expect(document.querySelector('.harness-body img')).toBeNull()
  })

  it('Save calls set() with the edited text and reports success', async () => {
    let saved: string | null = null
    openHarnessEditor({
      get: async () => 'orig',
      set: async (t) => {
        saved = t
        return { ok: true }
      }
    })
    await tick()
    const area = document.querySelector('.harness-area') as HTMLTextAreaElement
    area.value = 'edited harness body'
    ;(document.querySelector('.foot button.primary') as HTMLButtonElement).click()
    await tick()
    expect(saved).toBe('edited harness body')
    expect(document.querySelector('.harness-status')!.textContent).toContain('Saved')
  })

  it('surfaces a save error and re-enables Save for retry', async () => {
    openHarnessEditor({ get: async () => 'orig', set: async () => ({ error: 'disk full' }) })
    await tick()
    const save = document.querySelector('.foot button.primary') as HTMLButtonElement
    save.click()
    await tick()
    expect(document.querySelector('.harness-status.err')!.textContent).toContain('disk full')
    expect(save.disabled).toBe(false)
  })

  it('Close removes the modal', async () => {
    openHarnessEditor({ get: async () => 'x', set: async () => ({ ok: true }) })
    await tick()
    const closeBtn = Array.from(document.querySelectorAll('.foot button')).find(
      (b) => b.textContent === 'Close'
    ) as HTMLButtonElement
    closeBtn.click()
    expect(document.querySelector('.harness-modal')).toBeNull()
  })

  it('round-trips: reopening reflects the value set() persisted', async () => {
    let stored = 'v1'
    const deps = {
      get: async () => stored,
      set: async (t: string) => {
        stored = t
        return { ok: true as const }
      }
    }
    openHarnessEditor(deps)
    await tick()
    const area = document.querySelector('.harness-area') as HTMLTextAreaElement
    area.value = 'v2'
    ;(document.querySelector('.foot button.primary') as HTMLButtonElement).click()
    await tick()
    // Close and reopen: the new instance loads the persisted value.
    ;(
      Array.from(document.querySelectorAll('.foot button')).find(
        (b) => b.textContent === 'Close'
      ) as HTMLButtonElement
    ).click()
    openHarnessEditor(deps)
    await tick()
    expect((document.querySelector('.harness-area') as HTMLTextAreaElement).value).toBe('v2')
  })
})
