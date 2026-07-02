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
})
