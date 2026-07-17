// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { runAdvanceFlow, FIX_RESTART_CONFIRM } from '../../src/renderer/components/StageChip'
import { chooseOption } from '../../src/renderer/ui'
import type { Session } from '@shared/types'

function session(over: Partial<Session> = {}): Session {
  return {
    id: 's1', projectId: 'p1', provider: 'claude', model: 'claude-sonnet-4-6',
    objective: 'x', status: 'running', createdAt: 0, updatedAt: 0, ...over
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('runAdvanceFlow — fix-restart confirm gating', () => {
  it('host session → fix: NO confirm, calls setStage directly', async () => {
    let confirmed = false
    let stagedTo = ''
    const res = await runAdvanceFlow(session({ useContainer: false, effectiveStage: 'playback' }), 'fix', {
      confirm: async () => { confirmed = true; return true },
      setStage: async (_id, s) => { stagedTo = s; return { ok: true } }
    })
    expect(confirmed).toBe(false)
    expect(stagedTo).toBe('fix')
    expect(res).toEqual({ ok: true })
  })

  it('running container → fix: confirms with the exact message, then sets stage on OK', async () => {
    let message = ''
    let stagedTo = ''
    const res = await runAdvanceFlow(
      session({ useContainer: true, status: 'running', effectiveStage: 'playback', spawnedApprovalMode: 'guarded' }),
      'fix',
      { confirm: async (m) => { message = m; return true }, setStage: async (_id, s) => { stagedTo = s; return { ok: true } } }
    )
    expect(message).toBe(FIX_RESTART_CONFIRM)
    expect(stagedTo).toBe('fix')
    expect(res).toEqual({ ok: true })
  })

  it('running container → fix, user CANCELS: setStage is never called, returns null', async () => {
    let called = false
    const res = await runAdvanceFlow(
      session({ useContainer: true, status: 'running', effectiveStage: 'playback', spawnedApprovalMode: 'guarded' }),
      'fix',
      { confirm: async () => false, setStage: async () => { called = true; return { ok: true } } }
    )
    expect(called).toBe(false)
    expect(res).toBeNull()
  })

  it('container discussion→playback: label-only, no confirm', async () => {
    let confirmed = false
    await runAdvanceFlow(
      session({ useContainer: true, status: 'running', effectiveStage: 'discussion', spawnedApprovalMode: 'guarded' }),
      'playback',
      { confirm: async () => { confirmed = true; return true }, setStage: async () => ({ ok: true }) }
    )
    expect(confirmed).toBe(false)
  })
})

describe('runAdvanceFlow wired to the real chooseOption modal', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  it('renders the fix-restart confirm modal for a running container advance to fix', async () => {
    let staged = false
    const promise = runAdvanceFlow(
      session({ useContainer: true, status: 'running', effectiveStage: 'playback', spawnedApprovalMode: 'guarded' }),
      'fix',
      {
        confirm: (m) => chooseOption<'yes'>(m, [{ label: 'Restart in fix mode', value: 'yes', primary: true }]).then((r) => !!r),
        setStage: async () => { staged = true; return { ok: true } }
      }
    )
    await tick()
    const modal = document.querySelector('.modal-wrap.show')
    expect(modal).toBeTruthy()
    expect(modal!.querySelector('h3')!.textContent).toBe(FIX_RESTART_CONFIRM)
    // Confirm it.
    ;(Array.from(modal!.querySelectorAll('.foot button')).find((b) => b.textContent === 'Restart in fix mode') as HTMLButtonElement).click()
    await promise
    expect(staged).toBe(true)
  })

  it('cancelling the modal aborts the advance', async () => {
    let staged = false
    const promise = runAdvanceFlow(
      session({ useContainer: true, status: 'running', effectiveStage: 'playback', spawnedApprovalMode: 'guarded' }),
      'fix',
      {
        confirm: (m) => chooseOption<'yes'>(m, [{ label: 'Restart in fix mode', value: 'yes', primary: true }]).then((r) => !!r),
        setStage: async () => { staged = true; return { ok: true } }
      }
    )
    await tick()
    ;(Array.from(document.querySelectorAll('.foot button')).find((b) => b.textContent === 'Cancel') as HTMLButtonElement).click()
    const res = await promise
    expect(staged).toBe(false)
    expect(res).toBeNull()
  })
})
