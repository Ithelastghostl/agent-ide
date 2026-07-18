import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock electron so handlers register + can be invoked headlessly. The merged
// attention registrar (S5+S6) also uses ipcMain.on (pty:write), Notification,
// and BrowserWindow, so the mock covers those too.
const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn),
    on: () => {}
  },
  Notification: Object.assign(
    function () {
      return { show: () => {} }
    },
    { isSupported: () => false }
  ),
  BrowserWindow: { getAllWindows: () => [] }
}))

import { Store } from '../../src/main/store'
import { createFakeRuntime } from '../../src/main/runtime/fake'
import { LaunchService } from '../../src/main/launchService'
import { registerAttentionIpc } from '../../src/main/ipc/attention'
import { registerReviewIpc } from '../../src/main/ipc/review'
import type { IpcDeps } from '../../src/main/ipc/deps'
import type { Session } from '@shared/types'

function invoke(ch: string, ...args: unknown[]) {
  const fn = handlers.get(ch)
  if (!fn) throw new Error(`no handler ${ch}`)
  return fn({}, ...args)
}

function session(store: Store, over: Partial<Session>): Session {
  const now = Date.now()
  const s: Session = {
    id: 'x',
    projectId: 'p1',
    provider: 'claude',
    model: 'm',
    objective: 'o',
    status: 'running',
    createdAt: now,
    updatedAt: now,
    ...over
  }
  store.saveSession(s)
  return s
}

describe('session:handoff registers pending-review, never writes to the target pty (S6/C-14)', () => {
  let store: Store
  let runtime: ReturnType<typeof createFakeRuntime>
  let deps: IpcDeps
  const sent: { channel: string; payload: unknown }[] = []

  beforeEach(() => {
    handlers.clear()
    sent.length = 0
    runtime = createFakeRuntime()
    store = new Store(':memory:')
    store.saveProject({ id: 'p1', name: 'proj', repo: 'me/p', localPath: '/tmp/p', hasDevcontainer: false })
    const launch = new LaunchService({ runtime, store, onData: () => {}, onExit: () => {} })
    deps = {
      store,
      runtime,
      launch,
      projectRoot: (id) => store.getProject(id)?.localPath,
      send: (channel, payload) => sent.push({ channel, payload })
    }
    registerAttentionIpc(deps)
    registerReviewIpc(deps)
  })

  it('takes A’s cleaned tail, registers it as review for B, and writes NOTHING to B until review:insert', async () => {
    const a = session(store, { id: 'sA', objective: 'source' })
    const b = session(store, { id: 'sB', objective: 'target' })
    // Seed A's transcript with realistic pty output: ANSI colour + CRLF line
    // endings (a pty emits CRLF). Both must survive into the handoff (ANSI
    // stripped, CRLF text preserved — the handoff normalises CRLF→LF so stripAnsi
    // doesn't treat the trailing CR as a line-rewrite and drop the content).
    store.appendTranscript(a.id, '\x1b[32mhello from A\x1b[0m\r\nsecond line\r\n', Date.now())
    store.flush()
    // B is live so review:insert can later write to it.
    runtime.terminal.spawn({ id: b.id, shell: 'bash', args: [], cwd: '/tmp/p', env: {} }, () => {})

    // Handoff A -> B
    const res = (await invoke('session:handoff', a.id, b.id)) as {
      ok?: true
      targetInFix?: boolean
      error?: string
    }
    expect(res.error).toBeUndefined()
    expect(res.ok).toBe(true)

    // NO pty write happened to B (or anyone) from the handoff itself.
    expect(runtime.terminal.writes.length).toBe(0)
    // NO review-log row yet (write-ahead happens only at insert time).
    expect(store.reviewPayloadsForSession(b.id).length).toBe(0)

    // B now has pending review material.
    const pending = (await invoke('review:pending', b.id)) as { sections: unknown[]; totalChars: number }
    expect(pending.sections.length).toBe(1)
    expect(pending.totalChars).toBeGreaterThan(0)
    // renderer was told the review set changed for B.
    expect(sent.some((e) => e.channel === 'review:changed' && (e.payload as any).sessionId === b.id)).toBe(
      true
    )

    // Now the user inserts it: a review-log row IS created, and a bracketed paste
    // (no trailing newline) goes to B's pty.
    const ins = (await invoke('review:insert', b.id)) as { ok?: true; error?: string }
    expect(ins.error).toBeUndefined()
    expect(ins.ok).toBe(true)
    expect(store.reviewPayloadsForSession(b.id).length).toBe(1)
    // the payload contains A's cleaned text, stripped of ANSI, with BOTH CRLF
    // lines preserved (proving CRLF→LF normalisation before stripAnsi).
    const payload = store.reviewPayloadsForSession(b.id)[0]
    expect(payload).toContain('hello from A')
    expect(payload).toContain('second line')
    expect(payload).not.toContain('\x1b[')

    const write = runtime.terminal.writes.find((w) => w.id === b.id)
    expect(write).toBeTruthy()
    expect(write!.data.startsWith('\x1b[200~')).toBe(true) // bracketed paste start
    expect(write!.data.endsWith('\x1b[201~')).toBe(true) // bracketed paste end (NO trailing \n)
    expect(write!.data.endsWith('\n')).toBe(false)
  })

  it('reports targetInFix when B is in fix mode', async () => {
    const a = session(store, { id: 'sA2' })
    session(store, { id: 'sB2', effectiveStage: 'fix' })
    store.appendTranscript(a.id, 'some context', Date.now())
    store.flush()
    const res = (await invoke('session:handoff', 'sA2', 'sB2')) as { ok?: true; targetInFix?: boolean }
    expect(res.ok).toBe(true)
    expect(res.targetInFix).toBe(true)
  })

  it('refuses a self-handoff and an empty-transcript source', async () => {
    session(store, { id: 'sA3' })
    session(store, { id: 'sB3' })
    expect(((await invoke('session:handoff', 'sA3', 'sA3')) as any).error).toMatch(/itself/)
    // sA3 has no transcript -> refused
    expect(((await invoke('session:handoff', 'sA3', 'sB3')) as any).error).toMatch(/nothing to hand off/)
  })
})
