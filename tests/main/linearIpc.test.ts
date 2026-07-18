import { describe, it, expect, vi } from 'vitest'

// Mock electron ipcMain so we can register + invoke handlers headlessly.
const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn) },
  shell: { openExternal: () => Promise.resolve() }
}))

import { parseAction, registerLinearIpc } from '../../src/main/ipc/linear'
import { Store } from '../../src/main/store'
import { createFakeRuntime } from '../../src/main/runtime/fake'
import { LaunchService } from '../../src/main/launchService'
import type { IpcDeps } from '../../src/main/ipc/deps'

function invoke(ch: string, ...args: unknown[]) {
  const fn = handlers.get(ch)
  if (!fn) throw new Error(`no handler ${ch}`)
  return fn({}, ...args)
}

function deps(): IpcDeps {
  const runtime = createFakeRuntime()
  const store = new Store(':memory:')
  store.saveProject({ id: 'p1', name: 'proj', repo: 'me/p', localPath: '/tmp/p', hasDevcontainer: false })
  const launch = new LaunchService({ runtime, store, onData: () => {}, onExit: () => {} })
  return { store, runtime, launch, projectRoot: (id) => store.getProject(id)?.localPath, send: () => {} }
}

describe('parseAction', () => {
  it('accepts started/done', () => {
    expect(parseAction({ kind: 'started' })).toMatchObject({ action: { kind: 'started' }, mode: 'apply' })
    expect(parseAction({ kind: 'done', mode: 'preview' })).toMatchObject({
      action: { kind: 'done' },
      mode: 'preview'
    })
  })
  it('requires non-empty comment text', () => {
    expect(parseAction({ kind: 'comment' })).toEqual({ error: 'comment text required' })
    expect(parseAction({ kind: 'comment', text: '  ' })).toEqual({ error: 'comment text required' })
    expect(parseAction({ kind: 'comment', text: 'hi', sessionId: 's1' })).toMatchObject({
      action: { kind: 'comment', text: 'hi' },
      sessionId: 's1'
    })
  })
  it('rejects unknown/invalid actions', () => {
    expect(parseAction(null)).toEqual({ error: 'invalid action' })
    expect(parseAction({ kind: 'nope' })).toEqual({ error: 'unknown action kind: nope' })
  })
})

describe('linear IPC registrar', () => {
  it('status returns not-connected for a fresh project; invalid inputs are typed errors', async () => {
    handlers.clear()
    registerLinearIpc(deps())
    expect(await invoke('linear:status', 'p1')).toMatchObject({ connected: false })
    expect(await invoke('linear:status', 123)).toMatchObject({ error: 'invalid request' })
    expect(await invoke('linear:pull', 42)).toEqual({ error: 'invalid request' })
    expect(await invoke('linear:writeback', 'bl-1', { kind: 'bogus' })).toEqual({
      error: 'unknown action kind: bogus'
    })
  })

  it('pull on an unlinked project reports "project not linked" (no longer not-implemented)', async () => {
    handlers.clear()
    registerLinearIpc(deps())
    expect(await invoke('linear:pull', 'p1')).toEqual({ error: 'project not linked' })
  })
})
