import { describe, it, expect, beforeEach } from 'vitest'
import { Store } from '../../src/main/store'
import { projectId } from '../../src/main/projects'

function freshStore(): Store {
  return new Store(':memory:')
}

describe('Store', () => {
  let store: Store
  beforeEach(() => { store = freshStore() })

  it('round-trips a project', () => {
    store.saveProject({ id: 'p1', name: 'app', repo: 'me/app', localPath: '/x', hasDevcontainer: true })
    const list = store.listProjects()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: 'p1', name: 'app', hasDevcontainer: true })
  })

  it('round-trips sessions and filters by project', () => {
    store.saveProject({ id: 'p1', name: 'app', repo: 'me/app', localPath: '/x', hasDevcontainer: false })
    store.saveSession({ id: 's1', projectId: 'p1', provider: 'claude', model: 'sonnet', objective: 'a', status: 'running', createdAt: 1, updatedAt: 1 })
    store.saveSession({ id: 's2', projectId: 'p2', provider: 'codex', model: 'gpt', objective: 'b', status: 'running', createdAt: 2, updatedAt: 2 })
    expect(store.getSessions('p1')).toHaveLength(1)
    expect(store.getSessions('p1')[0].id).toBe('s1')
  })

  it('archives a session', () => {
    store.saveSession({ id: 's1', projectId: 'p1', provider: 'gemini', model: 'pro', objective: 'a', status: 'running', createdAt: 1, updatedAt: 1 })
    store.archiveSession('s1')
    expect(store.getSessions('p1')[0].status).toBe('archived')
  })

  it('setSessionStatus updates status (crash -> idle, not archived; Codex P1)', () => {
    store.saveSession({ id: 's1', projectId: 'p1', provider: 'codex', model: 'm', objective: 'a', status: 'running', createdAt: 1, updatedAt: 1 })
    store.setSessionStatus('s1', 'idle')
    expect(store.getSessions('p1')[0].status).toBe('idle')
    // history preserved regardless
    store.appendTranscript('s1', 'kept', 1)
    expect(store.getTranscript('s1')).toBe('kept')
  })

  it('renames a session (updates objective)', () => {
    store.saveSession({ id: 's1', projectId: 'p1', provider: 'codex', model: 'gpt', objective: 'old', status: 'running', createdAt: 1, updatedAt: 1 })
    store.renameSession('s1', 'new name')
    expect(store.getSessions('p1')[0].objective).toBe('new name')
  })

  it('appends and reads transcript chunks in order', () => {
    store.saveSession({ id: 's1', projectId: 'p1', provider: 'codex', model: 'gpt', objective: 'a', status: 'running', createdAt: 1, updatedAt: 1 })
    store.appendTranscript('s1', 'hello ', 1)
    store.appendTranscript('s1', 'world', 2)
    expect(store.getTranscript('s1')).toBe('hello world')
  })

  it('returns the full transcript when under the cap', () => {
    store.appendTranscript('s1', 'short output', 1)
    expect(store.getTranscript('s1', 1024)).toBe('short output')
  })

  it('tail-caps a large transcript to the most recent bytes, trimmed to a line start', () => {
    // 10 numbered lines; cap small enough to drop the earliest ones.
    for (let i = 0; i < 10; i++) store.appendTranscript('s1', `line${i}\n`, i)
    const out = store.getTranscript('s1', 20)
    expect(out.length).toBeLessThanOrEqual(20)
    expect(out).toMatch(/line9\n$/)        // keeps the END (most recent)
    expect(out).not.toContain('line0')      // drops the oldest
    expect(out.startsWith('line')).toBe(true) // begins at a line boundary, not mid-line
  })

  // B6: writes are batched (debounced) instead of one synchronous INSERT per
  // chunk. getTranscript must flush pending chunks first so a reconnect primer
  // always sees the latest output — no data lost in the buffer.
  it('B6: getTranscript flushes buffered chunks (no lost tail)', () => {
    for (let i = 0; i < 50; i++) store.appendTranscript('s1', `c${i};`, i)
    // read immediately, before any debounce timer could have fired
    const out = store.getTranscript('s1')
    expect(out).toBe(Array.from({ length: 50 }, (_, i) => `c${i};`).join(''))
  })

  it('B6: explicit flush() is idempotent and persists everything once', () => {
    store.appendTranscript('s1', 'a', 1)
    store.appendTranscript('s1', 'b', 2)
    store.flush()
    store.flush() // second flush must not duplicate
    expect(store.getTranscript('s1')).toBe('ab')
  })

  it('B6: tail cap is correct on a large transcript read newest-first', () => {
    // 2000 lines → well over a small cap; ensures the tail read returns the right
    // suffix without depending on concatenating the whole history.
    for (let i = 0; i < 2000; i++) store.appendTranscript('s1', `L${i}\n`, i)
    const out = store.getTranscript('s1', 64)
    expect(out.length).toBeLessThanOrEqual(64)
    expect(out).toMatch(/L1999\n$/)
    expect(out).not.toContain('L0\n')
    expect(out.startsWith('L')).toBe(true)
  })

  // B7: legacy rows use the old kebab-of-basename id (proj-app). migrateProjectIds
  // recomputes the durable hash id from (repo, localPath) and cascades the change
  // to sessions.projectId, so nothing is orphaned.
  it('B7: migrateProjectIds rewrites legacy ids and cascades to sessions', () => {
    // simulate two legacy projects that had COLLIDED under the old scheme but were
    // saved before the collision (or in separate installs); here just two distinct
    // legacy rows to prove cascade + new-id computation.
    store.saveProject({ id: 'proj-app', name: 'app', repo: 'owner1/app', localPath: '/a/app', hasDevcontainer: false })
    store.saveSession({ id: 's1', projectId: 'proj-app', provider: 'claude', model: 'm', objective: 'o', status: 'idle', createdAt: 1, updatedAt: 1 })

    store.migrateProjectIds()

    const expectedId = projectId('owner1/app', '/a/app')
    const projects = store.listProjects()
    expect(projects).toHaveLength(1)
    expect(projects[0].id).toBe(expectedId)
    expect(projects[0].name).toBe('app') // display name unchanged
    // the session now points at the new id (no orphan)
    expect(store.getSessions(expectedId)).toHaveLength(1)
    expect(store.getSessions('proj-app')).toHaveLength(0)
  })

  it('B7: migrateProjectIds is idempotent (already-migrated rows untouched)', () => {
    const id = projectId('owner/app', '/x/app')
    store.saveProject({ id, name: 'app', repo: 'owner/app', localPath: '/x/app', hasDevcontainer: false })
    store.migrateProjectIds()
    store.migrateProjectIds()
    expect(store.listProjects().map((p) => p.id)).toEqual([id])
  })

  // M-LOG-a: sessions carry task labels; the migration is additive + idempotent.
  it('M-LOG-a: round-trips task label fields on a session', () => {
    store.saveSession({
      id: 's1', projectId: 'p1', provider: 'claude', model: 'claude-opus-4-8', objective: 'o',
      status: 'running', createdAt: 1, updatedAt: 1,
      taskKind: 'product', taskSubkind: 'bug', taskStatus: 'open'
    })
    const s = store.getSessions('p1')[0]
    expect(s.taskKind).toBe('product')
    expect(s.taskSubkind).toBe('bug')
    expect(s.taskStatus).toBe('open')
  })

  it('M-LOG-a: a session without labels grandfathers to null task fields', () => {
    store.saveSession({ id: 's2', projectId: 'p1', provider: 'codex', model: 'gpt-5-codex', objective: 'o', status: 'running', createdAt: 1, updatedAt: 1 })
    const s = store.getSessions('p1')[0]
    expect(s.taskKind ?? null).toBeNull()
    expect(s.taskStatus ?? null).toBeNull()
  })

  it('M-LOG-a: setTaskStatus advances the lifecycle independently of runtime status', () => {
    store.saveSession({ id: 's3', projectId: 'p1', provider: 'claude', model: 'claude-opus-4-8', objective: 'o', status: 'running', createdAt: 1, updatedAt: 1, taskKind: 'product', taskSubkind: 'code', taskStatus: 'open' })
    store.setTaskStatus('s3', 'finished')
    const s = store.getSessions('p1')[0]
    expect(s.taskStatus).toBe('finished')
    expect(s.status).toBe('running') // runtime status untouched
  })

  it('M-LOG-a: migrateSessionTaskColumns is idempotent', () => {
    store.migrateSessionTaskColumns()
    store.migrateSessionTaskColumns() // second call must not throw
    store.saveSession({ id: 's4', projectId: 'p1', provider: 'gemini', model: 'gemini-2.5-pro', objective: 'o', status: 'running', createdAt: 1, updatedAt: 1, taskKind: 'analysis', taskStatus: 'open' })
    expect(store.getSessions('p1')[0].taskKind).toBe('analysis')
  })

  // M-LOG-b: tickets round-trip; getTickets is newest-first per project.
  it('M-LOG-b: saves and reads tickets newest-first', () => {
    store.saveTicket({ id: 't1', sessionId: 's1', projectId: 'p1', subkind: 'bug', title: 'First', bodyMd: '# First', fieldsJson: '{}', createdAt: 100 })
    store.saveTicket({ id: 't2', sessionId: 's2', projectId: 'p1', subkind: 'feature', title: 'Second', bodyMd: '# Second', fieldsJson: '{}', createdAt: 200 })
    store.saveTicket({ id: 't3', sessionId: 's3', projectId: 'p2', subkind: 'code', title: 'Other', bodyMd: '# Other', fieldsJson: '{}', createdAt: 300 })
    const p1 = store.getTickets('p1')
    expect(p1.map((t) => t.id)).toEqual(['t2', 't1']) // newest first
    expect(store.getTicketBySession('s1')?.title).toBe('First')
    expect(store.getTickets('p2')).toHaveLength(1)
  })

  it('M-LOG-b: saveTicket is idempotent (re-generate updates in place)', () => {
    store.saveTicket({ id: 't1', sessionId: 's1', projectId: 'p1', subkind: 'bug', title: 'V1', bodyMd: 'a', fieldsJson: '{}', createdAt: 1 })
    store.saveTicket({ id: 't1', sessionId: 's1', projectId: 'p1', subkind: 'bug', title: 'V2', bodyMd: 'b', fieldsJson: '{}', createdAt: 1 })
    expect(store.getTickets('p1')).toHaveLength(1)
    expect(store.getTickets('p1')[0].title).toBe('V2')
  })

  // B6: execution context persists with the session (host vs container).
  it('B6: useContainer round-trips through the store as boolean | null', () => {
    store.saveSession({ id: 'c1', projectId: 'p1', provider: 'codex', model: 'gpt-5-codex', objective: 'o', status: 'running', createdAt: 1, updatedAt: 1, useContainer: true })
    store.saveSession({ id: 'c2', projectId: 'p1', provider: 'codex', model: 'gpt-5-codex', objective: 'o', status: 'running', createdAt: 2, updatedAt: 2, useContainer: false })
    store.saveSession({ id: 'c3', projectId: 'p1', provider: 'codex', model: 'gpt-5-codex', objective: 'o', status: 'running', createdAt: 3, updatedAt: 3 })
    const by = Object.fromEntries(store.getSessions('p1').map((s) => [s.id, s.useContainer]))
    expect(by.c1).toBe(true)
    expect(by.c2).toBe(false)
    expect(by.c3).toBeNull() // grandfathered/unspecified stays null, not false
  })

  // R2-7: switching engines must persist the provider, not just the model.
  it('R2-7: the session upsert updates provider on conflict', () => {
    store.saveSession({ id: 'sw1', projectId: 'p1', provider: 'codex', model: 'gpt-5-codex', objective: 'o', status: 'running', createdAt: 1, updatedAt: 1 })
    store.saveSession({ id: 'sw1', projectId: 'p1', provider: 'claude', model: 'claude-opus-4-8', objective: 'o', status: 'running', createdAt: 1, updatedAt: 2 })
    const s = store.getSession('sw1')!
    expect(s.provider).toBe('claude')
    expect(s.model).toBe('claude-opus-4-8')
  })

  // R2-6: ticket row + 'ticketed' status move in ONE transaction.
  it('R2-6: finalizeTicket persists the ticket and the status atomically', () => {
    store.saveSession({ id: 'ft1', projectId: 'p1', provider: 'claude', model: 'claude-opus-4-8', objective: 'o', status: 'running', createdAt: 1, updatedAt: 1, taskKind: 'product', taskSubkind: 'bug', taskStatus: 'deployed' })
    store.finalizeTicket({ id: 'ticket-ft1', sessionId: 'ft1', projectId: 'p1', subkind: 'bug', title: 'T', bodyMd: '#', fieldsJson: '{}', createdAt: 5 })
    expect(store.getTicketBySession('ft1')?.id).toBe('ticket-ft1')
    expect(store.getSession('ft1')?.taskStatus).toBe('ticketed')
  })
})
