import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn) }
}))

import { Store } from '../../src/main/store'
import { createFakeRuntime } from '../../src/main/runtime/fake'
import { LaunchService } from '../../src/main/launchService'
import { registerQueueIpc } from '../../src/main/ipc/queue'
import { sessionEvents } from '../../src/main/sessionEvents'
import type { IpcDeps } from '../../src/main/ipc/deps'

function invoke(ch: string, ...args: unknown[]) {
  const fn = handlers.get(ch)
  if (!fn) throw new Error(`no handler ${ch}`)
  return fn({}, ...args)
}

describe('queue IPC — S6 autoAdvance flag + advancement triggers', () => {
  let store: Store
  let runtime: ReturnType<typeof createFakeRuntime>
  let launch: LaunchService
  let advanceSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    handlers.clear()
    // registerQueueIpc adds a process-wide 'archived' listener; in production it
    // registers exactly once, but each test re-registers, so clear stale ones so
    // an old closure (bound to a disposed LaunchService) can't fire here.
    sessionEvents.removeAllListeners('archived')
    process.env.AGENT_IDE_QUEUE = mkdtempSync(join(tmpdir(), 'agide-queue-'))
    runtime = createFakeRuntime()
    store = new Store(':memory:')
    store.saveProject({ id: 'p1', name: 'proj', repo: 'me/p', localPath: '/tmp/p', hasDevcontainer: false })
    launch = new LaunchService({ runtime, store, onData: () => {}, onExit: () => {} })
    // Spy on the gated advancement path so we can assert WHETHER S6 triggered it,
    // without depending on launch internals.
    advanceSpy = vi.spyOn(launch, 'launchNextQueued').mockResolvedValue(null)
    const deps: IpcDeps = {
      store,
      runtime,
      launch,
      projectRoot: (id) => store.getProject(id)?.localPath,
      send: () => {}
    }
    registerQueueIpc(deps)
  })
  afterEach(() => {
    delete process.env.AGENT_IDE_QUEUE
    vi.restoreAllMocks()
  })

  const enqueue = () =>
    invoke('queue:enqueue', { projectId: 'p1', provider: 'claude', model: 'm', objective: 'do it' })

  it('autoAdvance defaults to false and round-trips through set/get', async () => {
    expect(await invoke('queue:getAutoAdvance', 'p1')).toBe(false)
    expect(await invoke('queue:setAutoAdvance', 'p1', true)).toEqual({ ok: true, autoAdvance: true })
    expect(await invoke('queue:getAutoAdvance', 'p1')).toBe(true)
  })

  it('enqueue does NOT advance when autoAdvance is OFF', async () => {
    await enqueue()
    expect(advanceSpy).not.toHaveBeenCalled()
  })

  it('enqueue advances when autoAdvance is ON (R23-minor idle-enqueue wake-up)', async () => {
    await invoke('queue:setAutoAdvance', 'p1', true)
    advanceSpy.mockClear()
    await enqueue()
    expect(advanceSpy).toHaveBeenCalledWith('p1')
  })

  it('enabling autoAdvance false→true triggers advancement (R21); a no-op set does not', async () => {
    await enqueue()
    advanceSpy.mockClear()
    await invoke('queue:setAutoAdvance', 'p1', true) // false→true edge
    expect(advanceSpy).toHaveBeenCalledWith('p1')
    advanceSpy.mockClear()
    await invoke('queue:setAutoAdvance', 'p1', true) // already true → no edge
    expect(advanceSpy).not.toHaveBeenCalled()
  })

  it('Start next advances regardless of the autoAdvance setting', async () => {
    // autoAdvance stays OFF
    await invoke('queue:startNext', 'p1')
    expect(advanceSpy).toHaveBeenCalledWith('p1')
  })

  it('a committed archived event advances ONLY when autoAdvance is on (R31 completion trigger)', async () => {
    // autoAdvance off → archived event does not advance
    sessionEvents.emitEvent('archived', { id: 's1', projectId: 'p1' })
    await Promise.resolve()
    expect(advanceSpy).not.toHaveBeenCalled()
    // turn it on → archived advances
    await invoke('queue:setAutoAdvance', 'p1', true)
    advanceSpy.mockClear()
    sessionEvents.emitEvent('archived', { id: 's2', projectId: 'p1' })
    await Promise.resolve()
    expect(advanceSpy).toHaveBeenCalledWith('p1')
  })

  it('rejects binding more than 5 backlog items at selection (primer cap)', async () => {
    const res = (await invoke('queue:enqueue', {
      projectId: 'p1',
      provider: 'claude',
      model: 'm',
      objective: 'x',
      backlogItemIds: ['a', 'b', 'c', 'd', 'e', 'f']
    })) as any
    expect(res.error).toMatch(/5 backlog items/)
  })
})
