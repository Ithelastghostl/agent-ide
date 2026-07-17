import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock electron: capture ipcMain.handle + ipcMain.on handlers, stub Notification
// and BrowserWindow so the registrar wires headlessly.
const handlers = new Map<string, (...a: unknown[]) => unknown>()
const onListeners = new Map<string, ((...a: unknown[]) => void)[]>()
let focused = true
const shown: { title?: string; body?: string }[] = []

vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn),
    on: (ch: string, fn: (...a: unknown[]) => void) => {
      const arr = onListeners.get(ch) ?? []
      arr.push(fn)
      onListeners.set(ch, arr)
    }
  },
  Notification: class {
    static isSupported() { return true }
    constructor(public opts: { title?: string; body?: string }) {}
    show() { shown.push(this.opts) }
  },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, isFocused: () => focused }]
  }
}))

import { Store } from '../../src/main/store'
import { createFakeRuntime } from '../../src/main/runtime/fake'
import { LaunchService } from '../../src/main/launchService'
import { registerAttentionIpc } from '../../src/main/ipc/attention'
import { sessionEvents } from '../../src/main/sessionEvents'
import type { IpcDeps } from '../../src/main/ipc/deps'
import type { Session } from '../../src/shared/types'

function invoke(ch: string, ...args: unknown[]) {
  const fn = handlers.get(ch)
  if (!fn) throw new Error(`no handler ${ch}`)
  return fn({}, ...args)
}
function fireOn(ch: string, ...args: unknown[]) {
  for (const fn of onListeners.get(ch) ?? []) fn({}, ...args)
}

function mkSession(store: Store, id: string): Session {
  const s: Session = {
    id, projectId: 'p1', provider: 'claude', model: 'claude-opus-4-8',
    objective: 'x', status: 'running', createdAt: 0, updatedAt: 0
  }
  store.saveSession(s)
  return s
}

let sent: { channel: string; payload: unknown }[]
function deps(store: Store): IpcDeps {
  const runtime = createFakeRuntime()
  const launch = new LaunchService({ runtime, store, onData: () => {}, onExit: () => {} })
  return {
    store, runtime, launch,
    projectRoot: (id) => store.getProject(id)?.localPath,
    send: (channel, payload) => sent.push({ channel, payload })
  }
}

describe('registerAttentionIpc — bus wiring + cost persistence', () => {
  let store: Store
  beforeEach(() => {
    handlers.clear(); onListeners.clear(); shown.length = 0; sent = []; focused = true
    sessionEvents.removeAllListeners()
    process.env.AGENT_IDE_ATTENTION_QUIET_MS = '30' // short window for the test
    store = new Store(':memory:')
    store.saveProject({ id: 'p1', name: 'proj', repo: 'me/p', localPath: '/tmp/p', hasDevcontainer: false })
    registerAttentionIpc(deps(store))
  })

  it('attention:state starts empty and reflects a flagged session', async () => {
    mkSession(store, 's1')
    expect(await invoke('attention:state')).toEqual({})
    sessionEvents.emitEvent('output', { id: 's1', chunk: 'Do you want to proceed?\n' })
    await new Promise((r) => setTimeout(r, 60))
    expect(await invoke('attention:state')).toEqual({ s1: 'input' })
    // and the renderer got a session:attention event
    expect(sent.some((e) => e.channel === 'session:attention' && (e.payload as any).state === 'input')).toBe(true)
  })

  it('a cost summary in output is persisted to the Store and signalled', async () => {
    mkSession(store, 's2')
    sessionEvents.emitEvent('output', { id: 's2', chunk: 'Total cost: $0.42 (100 input, 200 output tokens)\n' })
    // cost:forSession returns the live summary
    const c = await invoke('cost:forSession', 's2') as any
    expect(c.costUSD).toBeCloseTo(0.42, 6)
    // persisted on the session row
    expect(store.getSession('s2')!.cost!.costUSD).toBeCloseTo(0.42, 6)
    // renderer signalled
    expect(sent.some((e) => e.channel === 'session:cost')).toBe(true)
  })

  it('cost:forSession returns unknown (never $0) when no summary exists', async () => {
    mkSession(store, 's3')
    expect(await invoke('cost:forSession', 's3')).toEqual({ error: 'unknown' })
  })

  it('pty:write clears a flagged session (second listener coexists)', async () => {
    mkSession(store, 's4')
    sessionEvents.emitEvent('output', { id: 's4', chunk: 'Proceed?\n' })
    await new Promise((r) => setTimeout(r, 60))
    expect(await invoke('attention:state')).toEqual({ s4: 'input' })
    fireOn('pty:write', 's4', 'y\r')
    expect(await invoke('attention:state')).toEqual({})
  })

  it('notifies when the app is unfocused', async () => {
    mkSession(store, 's5')
    focused = false
    sessionEvents.emitEvent('output', { id: 's5', chunk: 'Do you want to proceed?\n' })
    await new Promise((r) => setTimeout(r, 60))
    expect(shown.length).toBe(1)
    expect(shown[0].title).toMatch(/needs your input/i)
  })

  it('session:handoff stays stubbed until S6', async () => {
    expect(await invoke('session:handoff')).toEqual({ error: 'not-implemented' })
  })
})
