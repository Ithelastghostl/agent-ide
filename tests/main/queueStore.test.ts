import { describe, it, expect, beforeEach } from 'vitest'
import { Store } from '../../src/main/store'
import type { Session, QueueItem } from '@shared/types'

function enq(store: Store, projectId = 'p1', over: Partial<QueueItem> = {}) {
  return store.enqueue({
    projectId,
    objective: 'do a thing',
    provider: 'claude',
    model: 'claude-opus-4-8',
    useContainer: false,
    taskKind: 'product',
    taskSubkind: 'feature',
    agentRelPath: null,
    backlogItemIds: [],
    ...over
  } as any)
}

function session(store: Store, over: Partial<Session>): void {
  const now = Date.now()
  store.saveSession({
    id: 'x',
    projectId: 'p1',
    provider: 'claude',
    model: 'm',
    objective: 'o',
    status: 'running',
    createdAt: now,
    updatedAt: now,
    ...over
  })
}

describe('queue enqueue + ordering', () => {
  let store: Store
  beforeEach(() => {
    store = new Store(':memory:')
  })

  it('assigns increasing positions and lists in order', () => {
    const a = enq(store)
    const b = enq(store)
    const c = enq(store)
    const list = store.listQueue('p1')
    expect(list.map((q) => q.id)).toEqual([a.id, b.id, c.id])
    expect(list.map((q) => q.position)).toEqual([0, 1, 2])
  })

  it('reorder updates positions', () => {
    const a = enq(store)
    const b = enq(store)
    store.reorderQueue('p1', [b.id, a.id])
    expect(store.listQueue('p1').map((q) => q.id)).toEqual([b.id, a.id])
  })
})

describe('claimNextQueue atomicity + no-overtaking (R8)', () => {
  let store: Store
  beforeEach(() => {
    store = new Store(':memory:')
  })

  it('claims the oldest pending row with a fresh lease, bumping attempts', () => {
    const a = enq(store)
    enq(store)
    const claimed = store.claimNextQueue('p1', 'boot-1')
    expect(claimed?.id).toBe(a.id)
    expect(claimed?.state).toBe('launching')
    expect(claimed?.leaseToken).toBeTruthy()
    expect(claimed?.ownerBootId).toBe('boot-1')
    expect(claimed?.attempts).toBe(1)
  })

  it('refuses to claim while a launching row exists (no overtaking)', () => {
    enq(store)
    enq(store)
    const first = store.claimNextQueue('p1', 'boot-1')
    expect(first).not.toBeNull()
    // second claim blocked because first is still 'launching'
    expect(store.claimNextQueue('p1', 'boot-1')).toBeNull()
  })

  it('a repeated claim after marking launched can proceed', () => {
    const a = enq(store)
    const b = enq(store)
    const c1 = store.claimNextQueue('p1', 'boot-1')!
    expect(store.markQueueLaunched(c1.id, c1.leaseToken!, 'sess-a')).toBe(true)
    // now b is claimable
    const c2 = store.claimNextQueue('p1', 'boot-1')
    expect(c2?.id).toBe(b.id)
    void a
  })
})

describe('canAdvanceQueue (R9-1)', () => {
  let store: Store
  beforeEach(() => {
    store = new Store(':memory:')
  })

  it('blocks when a session is active', () => {
    enq(store)
    session(store, { id: 's1', status: 'running' })
    expect(store.canAdvanceQueue('p1')).toBe(false)
    store.setSessionStatus('s1', 'idle')
    expect(store.canAdvanceQueue('p1')).toBe(true)
  })

  it('blocks when a launched queue row is bound to a non-archived (interrupted) session', () => {
    const a = enq(store)
    const c = store.claimNextQueue('p1', 'boot-1')!
    store.markQueueLaunched(c.id, c.leaseToken!, 's-int')
    session(store, { id: 's-int', status: 'idle' }) // interrupted, non-archived
    expect(store.canAdvanceQueue('p1')).toBe(false)
    // archiving it unblocks
    store.saveSession({ ...store.getSession('s-int')!, status: 'archived' })
    expect(store.canAdvanceQueue('p1')).toBe(true)
    void a
  })
})

describe('lease transitions + recovery (R8/R9-2)', () => {
  let store: Store
  beforeEach(() => {
    store = new Store(':memory:')
  })

  it('markQueueLaunched requires a matching lease (CAS)', () => {
    enq(store)
    const c = store.claimNextQueue('p1', 'boot-1')!
    // wrong lease → no change
    expect(store.markQueueLaunched(c.id, 'wrong-lease', 's')).toBe(false)
    // correct lease → success
    expect(store.markQueueLaunched(c.id, c.leaseToken!, 's')).toBe(true)
  })

  it('reconcileQueueOnBoot re-pends dead-owner claims below the attempt cap', () => {
    enq(store)
    store.claimNextQueue('p1', 'old-boot') // attempts=1, owner=old-boot
    store.reconcileQueueOnBoot('new-boot')
    expect(store.listQueue('p1')[0].state).toBe('pending')
  })

  it('reconcileQueueOnBoot fails dead-owner claims at/above the attempt cap', () => {
    enq(store)
    store.claimNextQueue('p1', 'old-boot') // attempts=1
    // re-pend then re-claim to reach attempts=2
    store.reconcileQueueOnBoot('mid-boot')
    store.claimNextQueue('p1', 'old-boot-2') // attempts=2
    store.reconcileQueueOnBoot('new-boot')
    expect(store.listQueue('p1')[0].state).toBe('failed')
  })

  it('failStaleClaims fails this-boot launching rows past the bound', () => {
    enq(store)
    const c = store.claimNextQueue('p1', 'boot-1')!
    // negative bound => cutoff is in the future => claimedAt(now) < cutoff => stale
    const failed = store.failStaleClaims('boot-1', -1000)
    expect(failed).toContain(c.id)
    expect(store.getQueueItem(c.id)!.state).toBe('failed')
  })

  it('failStaleClaims spares fresh claims within the bound', () => {
    enq(store)
    const c = store.claimNextQueue('p1', 'boot-1')!
    expect(store.failStaleClaims('boot-1', 60_000)).toEqual([])
    expect(store.getQueueItem(c.id)!.state).toBe('launching')
  })
})
