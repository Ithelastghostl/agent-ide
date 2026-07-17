// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { LinearPanel, type LinearPanelProps, type WritebackPreview } from '../../src/renderer/components/LinearPanel'

function mount(overrides: Partial<LinearPanelProps> = {}): { root: HTMLElement; props: LinearPanelProps } {
  const props: LinearPanelProps = {
    status: { connected: true, account: 'acct-1', link: { accountId: 'acct-1', workspaceId: 'ws', teamId: null, projectId: null, label: 'Team X' } },
    rows: [{ id: 'bl-1', title: 'Fix the widget', remoteStatus: 'Todo', linearUrl: 'https://linear.app/x' }],
    onLink: vi.fn(),
    onPull: vi.fn(),
    onLogout: vi.fn(),
    onPreview: vi.fn(async () => ({ itemId: 'bl-1', identifier: 'ENG-1', title: 'Fix the widget', action: 'done', target: 'Done', alreadySatisfied: false } as WritebackPreview)),
    onApply: vi.fn(async () => ({ ok: true, outcome: 'applied' })),
    onCancel: vi.fn(),
    ...overrides
  }
  const root = LinearPanel(props)
  document.body.appendChild(root)
  return { root, props }
}

describe('LinearPanel', () => {
  it('renders rows and uses textContent (no innerHTML injection)', () => {
    const { root } = mount({ rows: [{ id: 'bl-1', title: '<img src=x onerror=alert(1)>', remoteStatus: 'Todo' }] })
    const rowTitle = root.querySelector('.linear-row b')!
    // The malicious string is rendered as TEXT, never parsed into an element.
    expect(rowTitle.textContent).toBe('<img src=x onerror=alert(1)>')
    expect(root.querySelector('.linear-row img')).toBeNull()
  })

  it('link/pull/logout invoke their callbacks', () => {
    const { root, props } = mount()
    ;(root.querySelector('.linear-link') as HTMLButtonElement).click()
    expect(props.onLink).toHaveBeenCalled()
    ;(root.querySelector('.linear-pull') as HTMLButtonElement).click()
    expect(props.onPull).toHaveBeenCalled()
    ;(root.querySelector('.linear-logout') as HTMLButtonElement).click()
    expect(props.onLogout).toHaveBeenCalledWith('acct-1')
  })

  it('disables Pull when not connected', () => {
    const { root } = mount({ status: { connected: false } })
    expect((root.querySelector('.linear-pull') as HTMLButtonElement).disabled).toBe(true)
  })

  it('a write-back shows a PREVIEW modal before applying (exact target shown)', async () => {
    const { root, props } = mount()
    ;(root.querySelector('.wb-done') as HTMLButtonElement).click()
    // preview resolves async → wait a microtask
    await Promise.resolve(); await Promise.resolve()
    const preview = document.querySelector('.linear-preview')
    expect(preview).toBeTruthy()
    expect(preview!.textContent).toContain('Done')
    expect(preview!.textContent).toContain('ENG-1')
    // onApply not yet called (preview only)
    expect(props.onApply).not.toHaveBeenCalled()
    // confirm applies
    ;(document.querySelector('.linear-apply') as HTMLButtonElement).click()
    await Promise.resolve(); await Promise.resolve()
    expect(props.onApply).toHaveBeenCalledWith('bl-1', { kind: 'done' })
  })

  it('preview flags an already-satisfied change as a no-op', async () => {
    const { root } = mount({
      onPreview: vi.fn(async () => ({ itemId: 'bl-1', identifier: 'ENG-1', title: 'Fix the widget', action: 'done', target: 'Done', alreadySatisfied: true } as WritebackPreview))
    })
    ;(root.querySelector('.wb-done') as HTMLButtonElement).click()
    await Promise.resolve(); await Promise.resolve()
    expect(document.querySelector('.linear-preview-noop')).toBeTruthy()
  })
})
