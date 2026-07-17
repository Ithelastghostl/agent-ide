import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock electron's ipcMain so we can register + invoke handlers headlessly.
const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn) }
}))

import { Store } from '../../src/main/store'
import { createFakeRuntime } from '../../src/main/runtime/fake'
import { LaunchService } from '../../src/main/launchService'
import { registerBacklogIpc, bindLaunchBacklog } from '../../src/main/ipc/backlog'
import type { IpcDeps } from '../../src/main/ipc/deps'
import type { Session } from '@shared/types'

function invoke(ch: string, ...args: unknown[]) {
  const fn = handlers.get(ch)
  if (!fn) throw new Error(`no handler ${ch}`)
  return fn({}, ...args)
}

function makeDeps(): IpcDeps {
  const runtime = createFakeRuntime()
  const store = new Store(':memory:')
  store.saveProject({ id: 'p1', name: 'proj', repo: 'me/p', localPath: '/tmp/p', hasDevcontainer: false })
  store.saveProject({ id: 'p2', name: 'other', repo: 'me/o', localPath: '/tmp/o', hasDevcontainer: false })
  const launch = new LaunchService({ runtime, store, onData: () => {}, onExit: () => {} })
  return { store, runtime, launch, projectRoot: (id) => store.getProject(id)?.localPath, send: () => {} }
}

function seedSession(store: Store, id: string, projectId: string) {
  const s: Session = { id, projectId, provider: 'codex', model: 'gpt-5-codex', objective: 'o', status: 'running', createdAt: 0, updatedAt: 0 }
  store.saveSession(s)
}

describe('backlog bind (S1)', () => {
  let d: IpcDeps
  beforeEach(() => { handlers.clear(); d = makeDeps(); registerBacklogIpc(d) })

  it('binds selected items and moves them to in-session', () => {
    const store = d.store!
    seedSession(store, 'sess-1', 'p1')
    const a = store.createBacklogItem({ projectId: 'p1', kind: 'task', title: 'A' }).item!
    const b = store.createBacklogItem({ projectId: 'p1', kind: 'task', title: 'B' }).item!
    const r = invoke('backlog:bind', 'sess-1', [a.id, b.id]) as { ok?: true; error?: string }
    expect(r.ok).toBe(true)
    expect(store.itemsForSession('sess-1').sort()).toEqual([a.id, b.id].sort())
    expect(store.getBacklogItem(a.id)!.sessionState).toBe('in-session')
  })

  it('rejects an unknown session', () => {
    expect((invoke('backlog:bind', 'nope', []) as { error?: string }).error).toMatch(/unknown session/)
  })

  it('refuses more than 5 items', () => {
    const store = d.store!
    seedSession(store, 'sess-2', 'p1')
    const ids = [1, 2, 3, 4, 5, 6].map((n) => store.createBacklogItem({ projectId: 'p1', kind: 'task', title: `T${n}` }).item!.id)
    expect((invoke('backlog:bind', 'sess-2', ids) as { error?: string }).error).toMatch(/at most 5/)
    expect(store.itemsForSession('sess-2').length).toBe(0)
  })

  it('only binds items from the session\'s own project (ownership check)', () => {
    const store = d.store!
    seedSession(store, 'sess-3', 'p1')
    const mine = store.createBacklogItem({ projectId: 'p1', kind: 'task', title: 'Mine' }).item!
    const theirs = store.createBacklogItem({ projectId: 'p2', kind: 'task', title: 'Theirs' }).item!
    bindLaunchBacklog(store, 'sess-3', 'p1', [mine.id, theirs.id])
    expect(store.itemsForSession('sess-3')).toEqual([mine.id])
  })

  it('is a no-op for an empty selection', () => {
    const store = d.store!
    seedSession(store, 'sess-4', 'p1')
    expect((bindLaunchBacklog(store, 'sess-4', 'p1', undefined)).ok).toBe(true)
    expect((bindLaunchBacklog(store, 'sess-4', 'p1', [])).ok).toBe(true)
    expect(store.itemsForSession('sess-4').length).toBe(0)
  })
})
