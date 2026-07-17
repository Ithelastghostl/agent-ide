import { describe, it, expect, beforeEach } from 'vitest'
import { Store } from '../../src/main/store'
import { createFakeRuntime } from '../../src/main/runtime/fake'
import {
  LaunchService, approvalMode, isAdjacentStage, reconcileKind, sessionMarker, AdmissionGate
} from '../../src/main/launchService'

function svc(over: Partial<ConstructorParameters<typeof LaunchService>[0]> = {}) {
  const runtime = createFakeRuntime()
  const store = new Store(':memory:')
  store.saveProject({ id: 'p1', name: 'proj', repo: 'me/proj', localPath: '/tmp/proj', hasDevcontainer: false })
  const svc = new LaunchService({ runtime, store, onData: () => {}, onExit: () => {}, ...over })
  return { runtime, store, svc }
}

describe('launchService pure policy', () => {
  it('approvalMode = auto only for fix + container', () => {
    expect(approvalMode('fix', true)).toBe('auto')
    expect(approvalMode('fix', false)).toBe('guarded')
    expect(approvalMode('playback', true)).toBe('guarded')
    expect(approvalMode('discussion', true)).toBe('guarded')
  })
  it('isAdjacentStage', () => {
    expect(isAdjacentStage('discussion', 'playback')).toBe(true)
    expect(isAdjacentStage('playback', 'fix')).toBe(true)
    expect(isAdjacentStage('discussion', 'fix')).toBe(false)
  })
  it('reconcileKind classifies relaunch vs label-only', () => {
    // model change → relaunch
    expect(reconcileKind({ stage: 'discussion', provider: 'claude', model: 'm2' }, { provider: 'claude', model: 'm1', approvalMode: 'guarded' }, false)).toBe('relaunch')
    // container discussion→fix flips approval → relaunch
    expect(reconcileKind({ stage: 'fix', provider: 'claude', model: 'm1' }, { provider: 'claude', model: 'm1', approvalMode: 'guarded' }, true)).toBe('relaunch')
    // host stage change: approval stays guarded → label-only
    expect(reconcileKind({ stage: 'fix', provider: 'claude', model: 'm1' }, { provider: 'claude', model: 'm1', approvalMode: 'guarded' }, false)).toBe('label-only')
  })
  it('sessionMarker', () => { expect(sessionMarker('sess-1')).toBe('AGENTIDE_SESSION=sess-1') })
})

describe('AdmissionGate serializes per project', () => {
  it('runs project ops in order, isolating projects', async () => {
    const gate = new AdmissionGate()
    const order: string[] = []
    const p1a = gate.run('p1', async () => { await new Promise((r) => setTimeout(r, 20)); order.push('p1a') })
    const p1b = gate.run('p1', async () => { order.push('p1b') })
    const p2 = gate.run('p2', async () => { order.push('p2') })
    await Promise.all([p1a, p1b, p2])
    // p1a before p1b (same chain); p2 independent
    expect(order.indexOf('p1a')).toBeLessThan(order.indexOf('p1b'))
    expect(order).toContain('p2')
  })
})

describe('launchService fresh launch → durable intent → promote', () => {
  let ctx: ReturnType<typeof svc>
  beforeEach(() => { ctx = svc() })

  it('a fresh launch defaults to discussion, guarded, and promotes to running', async () => {
    const s = await ctx.svc.launchSession({ projectId: 'p1', provider: 'claude', model: 'm', objective: 'do it', workspace: '/tmp/proj', useContainer: false })
    expect(s.status).toBe('running')
    expect(s.effectiveStage).toBe('discussion')
    expect(s.spawnedApprovalMode).toBe('guarded')
    expect(s.termState).toBe('live')
    expect(ctx.runtime.terminal.spawns).toHaveLength(1)
    // marker on env
    expect(ctx.runtime.terminal.spawns[0].env.AGENTIDE_SESSION).toBe(s.id)
  })

  it('never auto-approves a fresh container launch (discussion)', async () => {
    const s = await ctx.svc.launchSession({ projectId: 'p1', provider: 'claude', model: 'm', objective: 'x', workspace: '/tmp/proj', useContainer: true })
    expect(s.spawnedApprovalMode).toBe('guarded') // discussion ≠ fix
  })

  it('auto-submits the harness primer after promotion', async () => {
    const s = await ctx.svc.launchSession({ projectId: 'p1', provider: 'claude', model: 'm', objective: 'ship widget', workspace: '/tmp/proj', useContainer: false })
    const primed = ctx.runtime.terminal.primed.find((p) => p.id === s.id)
    expect(primed?.data).toContain('BEGIN HARNESS')
    expect(primed?.data).toContain('ship widget')
  })

  it('binds backlog items and moves them in-session', async () => {
    const item = ctx.store.createBacklogItem({ projectId: 'p1', kind: 'task', title: 'T' }).item!
    const s = await ctx.svc.launchSession({ projectId: 'p1', provider: 'claude', model: 'm', objective: 'x', workspace: '/tmp/proj', useContainer: false, backlogItemIds: [item.id] })
    expect(ctx.store.itemsForSession(s.id)).toContain(item.id)
    expect(ctx.store.getBacklogItem(item.id)!.sessionState).toBe('in-session')
  })

  it('refuses container launches in e2e mode', async () => {
    const c = svc({ e2eMode: true })
    await expect(c.svc.launchSession({ projectId: 'p1', provider: 'claude', model: 'm', objective: 'x', workspace: '/tmp/proj', useContainer: true }))
      .rejects.toThrow(/disabled in e2e/)
  })
})

describe('launchService declarative stage + reconcile (R27-R29)', () => {
  let ctx: ReturnType<typeof svc>
  beforeEach(() => { ctx = svc() })

  it('host stage change is label-only (no relaunch)', async () => {
    const s = await ctx.svc.launchSession({ projectId: 'p1', provider: 'claude', model: 'm', objective: 'x', workspace: '/tmp/proj', useContainer: false })
    const spawnsBefore = ctx.runtime.terminal.spawns.length
    ctx.svc.setDesiredStage(s.id, 'playback')
    await ctx.svc.reconcile(s.id)
    expect(ctx.runtime.terminal.spawns.length).toBe(spawnsBefore) // no relaunch
    expect(ctx.store.getSession(s.id)!.effectiveStage).toBe('playback')
  })

  it('rejects a non-adjacent stage jump', async () => {
    const s = await ctx.svc.launchSession({ projectId: 'p1', provider: 'claude', model: 'm', objective: 'x', workspace: '/tmp/proj', useContainer: false })
    expect(ctx.svc.setDesiredStage(s.id, 'fix').error).toMatch(/cannot jump/)
  })

  it('a model change triggers exactly one relaunch', async () => {
    const s = await ctx.svc.launchSession({ projectId: 'p1', provider: 'claude', model: 'm1', objective: 'x', workspace: '/tmp/proj', useContainer: false })
    const spawnsBefore = ctx.runtime.terminal.spawns.length
    ctx.svc.setDesiredModel(s.id, 'claude', 'm2')
    await ctx.svc.reconcile(s.id)
    expect(ctx.runtime.terminal.spawns.length).toBe(spawnsBefore + 1)
    const after = ctx.store.getSession(s.id)!
    expect(after.spawnedModel).toBe('m2')
    expect(after.status).toBe('running')
  })
})

describe('launchService boot reconciliation (R34/R36)', () => {
  it('host session without a pty → idle/terminated; container → uncertain', () => {
    const { store, svc: s } = svc()
    const now = Date.now()
    store.saveSession({ id: 'host1', projectId: 'p1', provider: 'claude', model: 'm', objective: 'o', status: 'running', createdAt: now, updatedAt: now, useContainer: false, termState: 'live' })
    store.saveSession({ id: 'cont1', projectId: 'p1', provider: 'claude', model: 'm', objective: 'o', status: 'running', createdAt: now, updatedAt: now, useContainer: true, termState: 'live' })
    s.reconcileOnBoot()
    expect(store.getSession('host1')!.status).toBe('idle')
    expect(store.getSession('host1')!.termState).toBe('terminated')
    expect(store.getSession('cont1')!.status).toBe('idle')
    expect(store.getSession('cont1')!.termState).toBe('uncertain')
  })
})

describe('launchService queue advancement (R21/R38)', () => {
  it('advances an eligible queue when a session archives', async () => {
    const { store, svc: s, runtime } = svc()
    store.enqueue({ projectId: 'p1', objective: 'queued work', provider: 'claude', model: 'm', useContainer: false, taskKind: 'product', taskSubkind: 'feature', agentRelPath: null, backlogItemIds: [] } as any)
    const launched = await s.launchNextQueued('p1')
    expect(launched?.status).toBe('running')
    expect(runtime.terminal.spawns.length).toBe(1)
    // the queue row is now launched, bound to the session
    expect(store.listQueue('p1')[0].state).toBe('launched')
    expect(store.listQueue('p1')[0].launchedSessionId).toBe(launched!.id)
  })

  it('refuses to advance while a session is active', async () => {
    const { store, svc: s } = svc()
    store.enqueue({ projectId: 'p1', objective: 'q', provider: 'claude', model: 'm', useContainer: false, taskKind: 'product', taskSubkind: 'feature', agentRelPath: null, backlogItemIds: [] } as any)
    await s.launchSession({ projectId: 'p1', provider: 'claude', model: 'm', objective: 'active', workspace: '/tmp/proj', useContainer: false })
    expect(await s.launchNextQueued('p1')).toBeNull()
  })
})
