import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Mock electron's ipcMain so we can register + invoke handlers headlessly.
const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn) }
}))

import { Store } from '../../src/main/store'
import { createFakeRuntime } from '../../src/main/runtime/fake'
import { LaunchService } from '../../src/main/launchService'
import { registerBacklogIpc } from '../../src/main/ipc/backlog'
import { registerHarnessIpc } from '../../src/main/ipc/harness'
import { registerSearchIpc } from '../../src/main/ipc/search'
import { registerLinearIpc } from '../../src/main/ipc/linear'
import { registerGitIpc } from '../../src/main/ipc/git'
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

describe('backlog IPC — main-enforced source authority (R17)', () => {
  let d: IpcDeps
  beforeEach(() => { handlers.clear(); d = deps(); registerBacklogIpc(d) })

  it('create forces source=manual and rejects unknown projects', async () => {
    expect((await invoke('backlog:create', { projectId: 'nope', kind: 'task', title: 'x' }) as any).error).toMatch(/unknown project/)
    const r = await invoke('backlog:create', { projectId: 'p1', kind: 'epic', title: 'Epic', source: 'linear', linearId: 'HACK' }) as any
    expect(r.item.source).toBe('manual')
    expect(r.item.linearId).toBeNull()
  })

  it('cannot update or delete generated/linear rows through generic CRUD', async () => {
    d.store!.upsertLinearBacklogItem({ projectId: 'p1', linearId: 'L1', linearUrl: 'u', title: 'L', bodyMd: '', remoteStatus: 'Todo' })
    const lin = d.store!.listBacklog('p1').find((i) => i.source === 'linear')!
    expect((await invoke('backlog:update', { id: lin.id, title: 'x' }) as any).error).toMatch(/read-only/)
    expect((await invoke('backlog:delete', lin.id) as any).error).toMatch(/read-only/)
  })

  it('lists items for a project', async () => {
    await invoke('backlog:create', { projectId: 'p1', kind: 'task', title: 'A' })
    expect((await invoke('backlog:list', 'p1') as any[]).length).toBe(1)
  })
})

describe('harness + search IPC (implemented)', () => {
  beforeEach(() => { handlers.clear(); process.env.AGENT_IDE_HARNESS = mkdtempSync(join(tmpdir(), 'agide-hipc-')) })
  afterEach(() => { delete process.env.AGENT_IDE_HARNESS })
  it('harness get returns text; set round-trips', async () => {
    const d = deps(); registerHarnessIpc(d)
    const text = await invoke('harness:get') as string
    expect(text).toContain('Discussion')
    expect((await invoke('harness:set', '# custom') as any).ok).toBe(true)
    expect(await invoke('harness:get')).toBe('# custom')
  })
  it('search returns hits', async () => {
    const d = deps(); registerSearchIpc(d)
    d.store!.createBacklogItem({ projectId: 'p1', kind: 'task', title: 'searchable widget' })
    const hits = await invoke('search:query', 'widget') as any[]
    expect(hits.some((h) => h.type === 'backlog')).toBe(true)
  })
})

describe('stubbed stream registrars return not-implemented', () => {
  beforeEach(() => { handlers.clear() })
  it('linear (implemented by S2) + deferred git snapshot/rollback stubs', async () => {
    const d = deps()
    registerLinearIpc(d); registerGitIpc(d)
    // S2 implements linear:pull — an unlinked project reports "project not linked"
    // (no longer the foundation not-implemented stub).
    expect(await invoke('linear:pull', 'p1')).toEqual({ error: 'project not linked' })
    // Snapshot/rollback/undo (#9) stay deferred per the SNAPSHOT scope decision.
    // (git:status/diff ARE implemented by S4 — covered in the git IPC block below.)
    expect(await invoke('snapshot:list', 'p1')).toEqual({ error: 'not-implemented' })
    expect(await invoke('git:rollbackPreview', 'snap')).toEqual({ error: 'not-implemented' })
    expect(await invoke('git:rollbackApply', 'tok')).toEqual({ error: 'not-implemented' })
  })
})

describe('git IPC (S4, implemented — read-only)', () => {
  beforeEach(() => { handlers.clear() })
  it('git:status / git:diff return null for a non-repo project (never throw)', async () => {
    const d = deps() // p1.localPath = /tmp/p, not a git repo
    registerGitIpc(d)
    expect(await invoke('git:status', 'p1')).toBeNull()
    expect(await invoke('git:diff', 'p1')).toBeNull()
  })
  it('git:status returns null for an unknown project (no root)', async () => {
    const d = deps()
    registerGitIpc(d)
    expect(await invoke('git:status', 'nope')).toBeNull()
    expect(await invoke('git:status', 42)).toBeNull() // non-string projectId
  })
})
