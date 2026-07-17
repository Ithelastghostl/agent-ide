import { describe, it, expect, beforeEach } from 'vitest'
import { Store, ftsQuery, effectiveStatus, canNest } from '../../src/main/store'
import type { Session } from '@shared/types'

function baseSession(over: Partial<Session>): Session {
  const now = Date.now()
  return {
    id: 's1', projectId: 'p1', provider: 'claude', model: 'claude-opus-4-8',
    objective: 'o', status: 'running', createdAt: now, updatedAt: now, ...over
  }
}

describe('backlog store — pure helpers', () => {
  it('ftsQuery escapes and quotes terms', () => {
    expect(ftsQuery('foo bar')).toBe('"foo" "bar"')
    expect(ftsQuery('a"b')).toBe('"a""b"')
    expect(ftsQuery('  ')).toBe('""')
    expect(ftsQuery('AND OR NOT')).toBe('"AND" "OR" "NOT"') // operators neutralized
  })
  it('effectiveStatus precedence: done-by-ticket > in-session > manual', () => {
    expect(effectiveStatus({ manualStatus: 'icebox', sessionState: 'done-by-ticket' })).toBe('done')
    expect(effectiveStatus({ manualStatus: 'icebox', sessionState: 'in-session' })).toBe('in-session')
    expect(effectiveStatus({ manualStatus: 'planned', sessionState: 'none' })).toBe('planned')
  })
  it('canNest enforces the hierarchy', () => {
    expect(canNest('epic', 'goal')).toBe(true)
    expect(canNest('epic', 'epic')).toBe(false)
    expect(canNest('goal', 'task')).toBe(true)
    expect(canNest('goal', 'goal')).toBe(false)
    expect(canNest('task', 'ticket')).toBe(false)
  })
})

describe('backlog CRUD + source authority (R17)', () => {
  let store: Store
  beforeEach(() => { store = new Store(':memory:') })

  it('creates a manual item and forces source=manual', () => {
    const { item } = store.createBacklogItem({ projectId: 'p1', kind: 'epic', title: 'Epic A' })
    expect(item?.source).toBe('manual')
    expect(item?.manualStatus).toBe('planned')
    expect(store.listBacklog('p1')).toHaveLength(1)
  })

  it('rejects invalid hierarchy on create', () => {
    const epic = store.createBacklogItem({ projectId: 'p1', kind: 'epic', title: 'E' }).item!
    const task = store.createBacklogItem({ projectId: 'p1', kind: 'task', title: 'T', parentId: epic.id }).item!
    const bad = store.createBacklogItem({ projectId: 'p1', kind: 'goal', title: 'G', parentId: task.id })
    expect(bad.error).toMatch(/cannot contain/)
  })

  it('refuses editing/deleting linear and generated rows through generic CRUD', () => {
    store.upsertLinearBacklogItem({ projectId: 'p1', linearId: 'LIN-1', linearUrl: 'http://x', title: 'L', bodyMd: '', remoteStatus: 'In Progress' })
    const lin = store.listBacklog('p1').find((i) => i.source === 'linear')!
    expect(store.updateBacklogItem({ id: lin.id, title: 'hacked' }).error).toMatch(/read-only/)
    expect(store.deleteBacklogItem(lin.id).error).toMatch(/read-only/)

    store.upsertGeneratedBacklogItem({ blId: 'bl-t1', projectId: 'p1', title: 'Gen', bodyMd: 'x', contentHash: 'h', createdAt: 1 })
    expect(store.updateBacklogItem({ id: 'bl-t1', title: 'hacked' }).error).toMatch(/read-only/)
  })

  it('delete re-parents children and is refused while an active session is bound', () => {
    const epic = store.createBacklogItem({ projectId: 'p1', kind: 'epic', title: 'E' }).item!
    const goal = store.createBacklogItem({ projectId: 'p1', kind: 'goal', title: 'G', parentId: epic.id }).item!
    const task = store.createBacklogItem({ projectId: 'p1', kind: 'task', title: 'T', parentId: goal.id }).item!
    // active session bound to goal → delete refused
    store.saveSession(baseSession({ id: 'sx', status: 'running' }))
    store.bindSessionBacklog('sx', [goal.id])
    expect(store.deleteBacklogItem(goal.id).error).toMatch(/active session/)
    // archive the session, now delete re-parents the task up to the epic
    store.saveSession(baseSession({ id: 'sx', status: 'archived' }))
    expect(store.deleteBacklogItem(goal.id).ok).toBe(true)
    expect(store.getBacklogItem(task.id)!.parentId).toBe(epic.id)
  })

  it('rejects cycles on reparent', () => {
    const a = store.createBacklogItem({ projectId: 'p1', kind: 'epic', title: 'A' }).item!
    const b = store.createBacklogItem({ projectId: 'p1', kind: 'goal', title: 'B', parentId: a.id }).item!
    // try to make A a child of B → cycle
    const r = store.updateBacklogItem({ id: a.id, parentId: b.id })
    expect(r.error).toMatch(/cycle|cannot contain/)
  })
})

describe('recomputeItemStatus (R34)', () => {
  let store: Store
  beforeEach(() => { store = new Store(':memory:') })

  it('moves through none → in-session → done-by-ticket → back to none', () => {
    const item = store.createBacklogItem({ projectId: 'p1', kind: 'task', title: 'T' }).item!
    store.saveSession(baseSession({ id: 's1', status: 'running' }))
    store.bindSessionBacklog('s1', [item.id])
    expect(store.getBacklogItem(item.id)!.sessionState).toBe('in-session')

    // crash → idle → recompute back to none (session boundary crossing)
    store.setSessionStatus('s1', 'idle')
    expect(store.getBacklogItem(item.id)!.sessionState).toBe('none')

    // resume → running → in-session again
    store.setSessionStatus('s1', 'running')
    expect(store.getBacklogItem(item.id)!.sessionState).toBe('in-session')

    // ticket the session → done-by-ticket
    store.setTaskStatus('s1', 'ticketed')
    store.recomputeItemStatus(item.id)
    expect(store.getBacklogItem(item.id)!.sessionState).toBe('done-by-ticket')
  })
})

describe('tickets → backlog migration (C-7) + finalizeTicket', () => {
  it('migrates existing tickets and finalizeTicket upserts the mirror row', () => {
    const s = new Store(':memory:')
    s.saveSession(baseSession({ id: 's1', taskKind: 'product', taskSubkind: 'bug', taskStatus: 'deployed' }))
    s.saveTicket({ id: 'ticket-s1', sessionId: 's1', projectId: 'p1', subkind: 'bug', title: 'Fix', bodyMd: '# Fix', fieldsJson: '{}', createdAt: 1 })
    // simulate an upgrade: re-run the migration (idempotent)
    s.migrateTicketsToBacklog()
    const gen = s.listBacklog('p1').filter((i) => i.source === 'generated')
    expect(gen).toHaveLength(1)
    expect(gen[0].id).toBe('bl-ticket-s1')

    // finalizeTicket also advances the session + binds recompute
    s.bindSessionBacklog('s1', [s.createBacklogItem({ projectId: 'p1', kind: 'task', title: 'work' }).item!.id])
    s.finalizeTicket({ id: 'ticket-s1', sessionId: 's1', projectId: 'p1', subkind: 'bug', title: 'Fix2', bodyMd: '# Fix2', fieldsJson: '{}', createdAt: 2 })
    expect(s.getSession('s1')!.taskStatus).toBe('ticketed')
    const bound = s.itemsForSession('s1').map((id) => s.getBacklogItem(id)!)
    expect(bound.some((i) => i.sessionState === 'done-by-ticket')).toBe(true)
  })
})

describe('FTS search (C-9/C-10)', () => {
  let store: Store
  beforeEach(() => { store = new Store(':memory:') })

  it('finds transcript and backlog hits and never errors on FTS syntax chars', () => {
    store.saveSession(baseSession({ id: 's1' }))
    store.appendTranscript('s1', 'the WIDGET race condition happened', 1)
    store.flush()
    store.createBacklogItem({ projectId: 'p1', kind: 'task', title: 'Fix the widget', bodyMd: 'about widgets' })

    const hits = store.search('widget')
    expect(hits.some((h) => h.type === 'transcript' && h.sessionId === 's1')).toBe(true)
    expect(hits.some((h) => h.type === 'backlog')).toBe(true)

    // syntax characters must not throw
    expect(() => store.search('AND OR ( "')).not.toThrow()
    expect(store.search('AND OR ( "')).toEqual([])
  })

  it('keeps FTS in sync across update and delete', () => {
    const item = store.createBacklogItem({ projectId: 'p1', kind: 'task', title: 'alpha' }).item!
    expect(store.search('alpha').length).toBeGreaterThan(0)
    store.updateBacklogItem({ id: item.id, title: 'bravo' })
    expect(store.search('alpha')).toEqual([])
    expect(store.search('bravo').length).toBeGreaterThan(0)
    store.deleteBacklogItem(item.id)
    expect(store.search('bravo')).toEqual([])
  })
})

describe('agent inbox ingestion dedupe (R21)', () => {
  it('ingests once per contentHash', () => {
    const s = new Store(':memory:')
    const a = s.ingestAgentBacklogItem({ projectId: 'p1', kind: 'goal', title: 'G', bodyMd: 'body', contentHash: 'h1' })
    expect(a).not.toBeNull()
    const dup = s.ingestAgentBacklogItem({ projectId: 'p1', kind: 'goal', title: 'G', bodyMd: 'body', contentHash: 'h1' })
    expect(dup).toBeNull()
    expect(s.listBacklog('p1')).toHaveLength(1)
  })
})
