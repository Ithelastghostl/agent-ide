// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { QueueDrawer, PRIMER_ITEM_CAP } from '../../src/renderer/components/QueueDrawer'
import type { Model, QueueItem } from '@shared/types'

const models: Record<string, Model[]> = {
  claude: [{ id: 'claude-opus-4-8', label: 'Opus 4.8' } as Model],
  codex: [{ id: 'gpt-5-codex', label: 'Codex' } as Model],
  gemini: [{ id: 'gemini-2', label: 'Gemini' } as Model]
}
const modelsFor = (p: string) => models[p] ?? []

function item(over: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'q1', projectId: 'p1', objective: 'do a thing', provider: 'claude', model: 'claude-opus-4-8',
    useContainer: false, backlogItemIds: [], position: 0, state: 'pending', attempts: 0, createdAt: 0, ...over
  }
}

function baseProps(over: Partial<Parameters<typeof QueueDrawer>[0]> = {}) {
  return {
    projectName: 'proj', items: [] as QueueItem[], autoAdvance: false, modelsFor: modelsFor as any,
    onEnqueue: vi.fn(async () => ({ item: item() })),
    onDelete: vi.fn(), onReorder: vi.fn(), onStartNext: vi.fn(),
    onToggleAutoAdvance: vi.fn(), onClose: vi.fn(), ...over
  }
}

describe('QueueDrawer', () => {
  it('renders the compose form with useContainer defaulting to FALSE', () => {
    const el = QueueDrawer(baseProps())
    const uc = el.querySelector('.q-usecontainer-cb') as HTMLInputElement
    expect(uc).toBeTruthy()
    expect(uc.checked).toBe(false)
  })

  it('rejects an empty objective before enqueue', async () => {
    const onEnqueue = vi.fn(async () => ({ item: item() }))
    const el = QueueDrawer(baseProps({ onEnqueue }))
    ;(el.querySelector('.q-add') as HTMLButtonElement).click()
    await Promise.resolve()
    expect(onEnqueue).not.toHaveBeenCalled()
    expect((el.querySelector('.q-error') as HTMLElement).textContent).toMatch(/objective/i)
  })

  it('rejects binding more than the 5-item primer cap AT SELECTION (never enqueues)', async () => {
    const onEnqueue = vi.fn(async () => ({ item: item() }))
    const el = QueueDrawer(baseProps({ onEnqueue }))
    ;(el.querySelector('.q-objective') as HTMLInputElement).value = 'ship it'
    ;(el.querySelector('.q-backlog') as HTMLInputElement).value = 'a b c d e f' // 6 ids
    ;(el.querySelector('.q-add') as HTMLButtonElement).click()
    await Promise.resolve()
    expect(onEnqueue).not.toHaveBeenCalled()
    expect((el.querySelector('.q-error') as HTMLElement).textContent).toContain(String(PRIMER_ITEM_CAP))
  })

  it('enqueues with objective + provider + model + useContainer + backlog ids', async () => {
    const onEnqueue = vi.fn(async () => ({ item: item() }))
    const el = QueueDrawer(baseProps({ onEnqueue }))
    const provider = el.querySelector('.q-provider') as HTMLSelectElement
    provider.value = 'claude'
    provider.dispatchEvent(new Event('change')) // repopulate models for claude
    ;(el.querySelector('.q-objective') as HTMLInputElement).value = 'ship it'
    ;(el.querySelector('.q-backlog') as HTMLInputElement).value = 'bl-1, bl-2'
    ;(el.querySelector('.q-add') as HTMLButtonElement).click()
    await Promise.resolve(); await Promise.resolve()
    expect(onEnqueue).toHaveBeenCalledWith({
      provider: 'claude', model: 'claude-opus-4-8', objective: 'ship it', useContainer: false, backlogItemIds: ['bl-1', 'bl-2']
    })
  })

  it('renders one row per queued item with a state chip and provider/model meta', () => {
    const items = [item({ id: 'q1', objective: 'A', state: 'pending' }), item({ id: 'q2', position: 1, objective: 'B', state: 'launching' })]
    const el = QueueDrawer(baseProps({ items }))
    const rows = el.querySelectorAll('.q-item')
    expect(rows.length).toBe(2)
    expect(el.querySelector('.q-chip.pending')).toBeTruthy()
    expect(el.querySelector('.q-chip.launching')).toBeTruthy()
  })

  it('shows lastError on a failed item', () => {
    const items = [item({ state: 'failed', lastError: 'boom went the launch' })]
    const el = QueueDrawer(baseProps({ items }))
    expect((el.querySelector('.q-item-error') as HTMLElement).textContent).toBe('boom went the launch')
  })

  it('reorder up/down hands onReorder a swapped id list', () => {
    const onReorder = vi.fn()
    const items = [item({ id: 'q1', position: 0 }), item({ id: 'q2', position: 1 }), item({ id: 'q3', position: 2 })]
    const el = QueueDrawer(baseProps({ items, onReorder }))
    // move the second item up
    const rows = el.querySelectorAll('.q-item')
    ;(rows[1].querySelector('.q-up') as HTMLButtonElement).click()
    expect(onReorder).toHaveBeenCalledWith(['q2', 'q1', 'q3'])
  })

  it('Start next is enabled only when a pending item exists', () => {
    const disabledEl = QueueDrawer(baseProps({ items: [item({ state: 'launched' })] }))
    expect((disabledEl.querySelector('.q-startnext') as HTMLButtonElement).disabled).toBe(true)
    const enabledEl = QueueDrawer(baseProps({ items: [item({ state: 'pending' })] }))
    expect((enabledEl.querySelector('.q-startnext') as HTMLButtonElement).disabled).toBe(false)
  })

  it('Start next fires onStartNext', () => {
    const onStartNext = vi.fn()
    const el = QueueDrawer(baseProps({ items: [item({ state: 'pending' })], onStartNext }))
    ;(el.querySelector('.q-startnext') as HTMLButtonElement).click()
    expect(onStartNext).toHaveBeenCalled()
  })

  it('autoAdvance toggle reflects state and fires onToggleAutoAdvance', () => {
    const onToggleAutoAdvance = vi.fn()
    const el = QueueDrawer(baseProps({ autoAdvance: true, onToggleAutoAdvance }))
    const cb = el.querySelector('.q-autoadvance-cb') as HTMLInputElement
    expect(cb.checked).toBe(true)
    cb.checked = false
    cb.dispatchEvent(new Event('change'))
    expect(onToggleAutoAdvance).toHaveBeenCalledWith(false)
  })
})
