// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { ModelPicker } from '../../src/renderer/components/ModelPicker'
import type { Model, Effort } from '@shared/types'

const MODELS: Model[] = [{ id: 'm1', label: 'model one', tier: 'balanced' }]

function mount(props: Partial<Parameters<typeof ModelPicker>[0]> = {}) {
  const onPick = vi.fn()
  const el = ModelPicker({
    provider: 'claude',
    models: MODELS,
    onPick,
    onCancel: () => {},
    ...props
  })
  document.body.replaceChildren(el)
  return { el, onPick }
}

const effortButtons = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLButtonElement>('.mp-effort-btn')]
const buttonNamed = (el: HTMLElement, text: string) =>
  effortButtons(el).find((b) => b.textContent === text)!
const selected = (el: HTMLElement) => effortButtons(el).find((b) => b.classList.contains('on'))?.textContent

describe('ModelPicker effort row', () => {
  it('offers Default plus every effort level', () => {
    const { el } = mount()
    expect(effortButtons(el).map((b) => b.textContent)).toEqual([
      'Default',
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ])
  })

  it('defaults to Default — no flag, provider CLI config wins', () => {
    const { el, onPick } = mount()
    expect(selected(el)).toBe('Default')
    el.querySelector<HTMLElement>('.mopt')!.click()
    expect(onPick).toHaveBeenCalledWith('claude', 'm1', null)
  })

  it('carries the picked effort out on launch', () => {
    const { el, onPick } = mount()
    buttonNamed(el, 'high').click()
    expect(selected(el)).toBe('high')
    el.querySelector<HTMLElement>('.mopt')!.click()
    expect(onPick).toHaveBeenCalledWith('claude', 'm1', 'high')
  })

  it('preselects an effort passed in', () => {
    const { el } = mount({ effort: 'low' as Effort })
    expect(selected(el)).toBe('low')
  })

  it('hides the row for gemini — that CLI has no effort concept', () => {
    const { el } = mount({ provider: 'gemini' })
    expect(el.querySelector<HTMLElement>('.mp-effort')!.hidden).toBe(true)
  })

  it('never emits an effort for gemini even if one was preselected', () => {
    const { el, onPick } = mount({ provider: 'gemini', effort: 'max' as Effort })
    el.querySelector<HTMLElement>('.mopt')!.click()
    expect(onPick).toHaveBeenCalledWith('gemini', 'm1', null)
  })

  describe('when AGENT_IDE_EFFORT forces a level', () => {
    it('locks the row to that level and disables the buttons', () => {
      const { el } = mount({ forcedEffort: 'max' as Effort, effort: 'low' as Effort })
      expect(selected(el)).toBe('max')
      expect(effortButtons(el).every((b) => b.disabled)).toBe(true)
    })

    it('says WHY the row is locked', () => {
      const { el } = mount({ forcedEffort: 'max' as Effort })
      expect(el.querySelector('.mp-effort-label')!.textContent).toContain('AGENT_IDE_EFFORT')
    })

    it('launches with the forced level, not the preselected one', () => {
      const { el, onPick } = mount({ forcedEffort: 'max' as Effort, effort: 'low' as Effort })
      el.querySelector<HTMLElement>('.mopt')!.click()
      expect(onPick).toHaveBeenCalledWith('claude', 'm1', 'max')
    })
  })
})
