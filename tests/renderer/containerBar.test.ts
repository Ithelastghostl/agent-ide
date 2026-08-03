// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { Cockpit } from '../../src/renderer/components/Cockpit'

type Props = Parameters<typeof Cockpit>[0]

function mount(extra: Partial<Props> = {}) {
  const onToggleContainerMode = vi.fn()
  const onStartContainer = vi.fn()
  const onStopContainer = vi.fn()
  const el = Cockpit({
    sessions: [],
    activeSessionId: null,
    onLaunch: () => {},
    onSelectSession: () => {},
    showContainerButton: true,
    onToggleContainerMode,
    onStartContainer,
    onStopContainer,
    ...extra
  } as Props)
  return { el, onToggleContainerMode, onStartContainer, onStopContainer }
}

const where = (el: HTMLElement) => el.querySelector('.cx-where')!.textContent
const sub = (el: HTMLElement) => el.querySelector('.cx-sub')!.textContent
const connBtn = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.cx-conn')!

describe('container bar — am I inside the container?', () => {
  it('is hidden for projects without a devcontainer', () => {
    const { el } = mount({ showContainerButton: false })
    expect(el.querySelector('.container-bar')).toBeNull()
  })

  it('sits between the library pills and the sessions list', () => {
    const { el } = mount()
    const kids = [...el.children]
    const bar = kids.findIndex((c) => c.classList.contains('container-bar'))
    const pills = kids.findIndex((c) => c.classList.contains('libpills'))
    const secs = kids.filter((c) => c.classList.contains('cp-sec'))
    const sessionsSec = kids.indexOf(secs[secs.length - 1])
    expect(pills).toBeGreaterThan(-1)
    expect(bar).toBeGreaterThan(pills) // below Library
    expect(bar).toBeLessThan(sessionsSec) // above Sessions
  })

  it('says sessions run on the host when disconnected', () => {
    const { el } = mount({ inContainer: false, containerState: 'none' })
    expect(where(el)).toBe('Sessions run on the host')
    expect(connBtn(el).textContent).toBe('⇥ Connect')
  })

  it('says sessions run in the container when connected', () => {
    const { el } = mount({ inContainer: true, containerState: 'running' })
    expect(where(el)).toBe('Sessions run in the container')
    expect(connBtn(el).textContent).toBe('⤫ Disconnect')
  })

  it('reports the container state separately from the run mode', () => {
    // The case that motivated the split: container UP, sessions still on host.
    const { el } = mount({ inContainer: false, containerState: 'running' })
    expect(where(el)).toBe('Sessions run on the host')
    expect(sub(el)).toBe('container running')
  })

  it.each([
    ['none', 'container not built'],
    ['stopped', 'container stopped'],
    ['starting', 'container starting…'],
    ['running', 'container running'],
    ['error', 'container failed to start']
  ] as const)('labels container state %s', (state, text) => {
    const { el } = mount({ containerState: state })
    expect(sub(el)).toBe(text)
  })

  it('fires the toggle on Connect', () => {
    const { el, onToggleContainerMode } = mount({ inContainer: false })
    connBtn(el).click()
    expect(onToggleContainerMode).toHaveBeenCalledOnce()
  })

  it('fires the toggle on Disconnect', () => {
    const { el, onToggleContainerMode } = mount({ inContainer: true })
    connBtn(el).click()
    expect(onToggleContainerMode).toHaveBeenCalledOnce()
  })

  it('disables Connect mid-start so it cannot double-fire', () => {
    const { el } = mount({ containerState: 'starting' })
    expect(connBtn(el).disabled).toBe(true)
  })

  it('keeps the lifecycle button independent of the mode toggle', () => {
    const { el, onStopContainer, onToggleContainerMode } = mount({
      inContainer: true,
      containerState: 'running'
    })
    el.querySelector<HTMLButtonElement>('.container-btn.stop')!.click()
    expect(onStopContainer).toHaveBeenCalledOnce()
    expect(onToggleContainerMode).not.toHaveBeenCalled()
  })

  it('offers to start the container when it is not up', () => {
    const { el, onStartContainer } = mount({ containerState: 'none' })
    const start = [...el.querySelectorAll<HTMLButtonElement>('.container-btn')].find(
      (b) => b.textContent === '▶ Build & start'
    )!
    start.click()
    expect(onStartContainer).toHaveBeenCalledOnce()
  })

  it('marks the status row when connected, for the visual cue', () => {
    expect(mount({ inContainer: true }).el.querySelector('.cx-status')!.classList).toContain('on')
    expect(mount({ inContainer: false }).el.querySelector('.cx-status')!.classList).not.toContain('on')
  })

  it('treats an absent inContainer as host (no accidental container launch)', () => {
    const { el } = mount({})
    expect(where(el)).toBe('Sessions run on the host')
  })
})
