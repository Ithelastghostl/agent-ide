// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { LibraryPanel } from '../../src/renderer/components/LibraryPanel'
import type { LibraryItem } from '@shared/types'

const ITEMS: LibraryItem[] = [
  { category: 'agents', name: 'a1', description: 'first agent', relPath: 'agents/a1.md', path: '/x/agents/a1.md' }
]

function mount(props: Partial<Parameters<typeof LibraryPanel>[0]> = {}) {
  const onSync = vi.fn()
  const el = LibraryPanel({
    category: 'agents',
    items: ITEMS,
    hasActiveSession: false,
    onUse: () => {},
    onSync,
    onCancel: () => {},
    ...props
  })
  document.body.replaceChildren(el)
  return { el, onSync }
}

const msg = (el: HTMLElement) => el.querySelector('.lib-syncmsg')!.textContent
const btn = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.lib-sync')!

describe('LibraryPanel sync control', () => {
  it('is absent when no sync handler is supplied', () => {
    const el = LibraryPanel({
      category: 'agents',
      items: ITEMS,
      hasActiveSession: false,
      onUse: () => {},
      onCancel: () => {}
    })
    expect(el.querySelector('.lib-syncbar')).toBeNull()
  })

  it('reports an unconfigured library instead of failing silently', () => {
    const { el } = mount({ status: { isClone: false, dir: '/x' } })
    expect(msg(el)).toBe('No library repo connected yet.')
    expect(btn(el).textContent).toBe('Connect repo')
  })

  it('offers a pull once a repo is connected', () => {
    const { el } = mount({ status: { isClone: true, dir: '/x' } })
    expect(msg(el)).toBe('Connected to a git remote.')
    expect(btn(el).textContent).toBe('Sync now')
  })

  it('fires the sync handler on click', () => {
    const { el, onSync } = mount({ status: { isClone: true, dir: '/x' } })
    btn(el).click()
    expect(onSync).toHaveBeenCalledOnce()
  })

  it('disables the button while a sync runs', () => {
    const { el } = mount({ status: { isClone: true, dir: '/x' }, syncing: true })
    expect(btn(el).disabled).toBe(true)
    expect(msg(el)).toBe('Syncing…')
  })

  it('surfaces a sync error, flagged as an error', () => {
    const { el } = mount({
      status: { isClone: false, dir: '/x' },
      syncMessage: 'Error: no library repo configured yet'
    })
    expect(msg(el)).toContain('no library repo configured yet')
    expect(el.querySelector('.lib-syncmsg')!.classList.contains('err')).toBe(true)
  })

  it('surfaces success without the error style', () => {
    const { el } = mount({ status: { isClone: true, dir: '/x' }, syncMessage: 'Library up to date.' })
    expect(msg(el)).toBe('Library up to date.')
    expect(el.querySelector('.lib-syncmsg')!.classList.contains('err')).toBe(false)
  })
})
