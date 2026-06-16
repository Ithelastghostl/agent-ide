import { describe, it, expect, beforeEach } from 'vitest'
import { Store } from '../../src/main/store'

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
})
