import { describe, it, expect } from 'vitest'
import { createRuntime } from '../../src/main/runtime'
import { createFakeRuntime } from '../../src/main/runtime/fake'
import type { Runtime } from '../../src/main/runtime'

// M1 exit: the platform seam is implementable and testable against FAKE adapters
// (no real node-pty/docker/net). This is what lets M2 (Win32) / M3* (Darwin) plug
// in behind the same interfaces. createRuntime() picks the Linux impl; the fake
// stands in for tests.

describe('runtime seam (M1)', () => {
  it('createRuntime() returns a runtime with all four platform parts', () => {
    const rt: Runtime = createRuntime()
    expect(typeof rt.terminal.spawn).toBe('function')
    expect(typeof rt.container.up).toBe('function')
    expect(typeof rt.host.probeHealth).toBe('function')
    expect(typeof rt.ports.ensure).toBe('function')
  })

  it('the fake terminal records spawns and drives onExit on kill', () => {
    const rt = createFakeRuntime()
    const exits: string[] = []
    rt.terminal.spawn({ id: 's1', shell: 'bash', args: [], cwd: '/x', env: {} }, () => {}, (i) => exits.push(i.reason))
    expect(rt.terminal.spawns).toHaveLength(1)
    expect(rt.terminal.spawns[0].id).toBe('s1')
    rt.terminal.kill('s1')
    expect(rt.terminal.killed).toEqual(['s1'])
    expect(exits).toEqual(['closed']) // kill → clean close
  })

  it('the fake terminal can simulate a crash (reason=crashed)', () => {
    const rt = createFakeRuntime()
    const exits: string[] = []
    rt.terminal.spawn({ id: 's2', shell: 'bash', args: [], cwd: '/x', env: {} }, () => {}, (i) => exits.push(i.reason))
    rt.terminal.crash('s2')
    expect(exits).toEqual(['crashed'])
  })

  it('the fake container brings up a container and resolves a configured user', async () => {
    const rt = createFakeRuntime()
    rt.container.userByContainer.set('c-1', 'node')
    const { containerId } = await rt.container.up('/ws', ['type=bind,...'])
    expect(containerId).toMatch(/^fake-container-/)
    expect(rt.container.ups[0]).toEqual({ workspace: '/ws', mounts: ['type=bind,...'] })
    expect(await rt.container.resolveUser('c-1')).toBe('node')
    expect(await rt.container.resolveUser('unknown')).toBeNull()
  })

  it('the fake container reports presence and running state per workspace', async () => {
    const rt = createFakeRuntime()
    expect(await rt.container.findPresence('/ws')).toEqual({ state: 'none' })
    rt.container.presenceByWorkspace.set('/ws', { state: 'running', id: 'c-9' })
    expect(await rt.container.findPresence('/ws')).toEqual({ state: 'running', id: 'c-9' })
    rt.container.runningByWorkspace.set('/ws', 'c-9')
    expect(await rt.container.findRunning('/ws')).toBe('c-9')
  })

  it('the fake port service refcounts forwards and disposes', async () => {
    const rt = createFakeRuntime()
    expect(await rt.ports.ensure('c', 3000, 'sessionA')).toBe(true)
    await rt.ports.ensure('c', 3000, 'sessionB')
    expect(rt.ports.active.get('c:3000')!.size).toBe(2)
    await rt.ports.release('c', 3000, 'sessionA')
    expect(rt.ports.active.get('c:3000')!.size).toBe(1) // still up for sessionB
    await rt.ports.disposeAll()
    expect(rt.ports.disposed).toBe(true)
    expect(rt.ports.active.size).toBe(0)
  })

  it('the fake host runtime probes health and records installs', async () => {
    const rt = createFakeRuntime()
    rt.host.healthResult = 'not-logged-in'
    expect(await rt.host.probeHealth('claude', { containerId: 'c' })).toBe('not-logged-in')
    await rt.host.installInContainer('codex', 'c-2')
    expect(rt.host.installed).toEqual([{ provider: 'codex', containerId: 'c-2' }])
  })
})
