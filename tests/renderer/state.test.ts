import { describe, it, expect } from 'vitest'
import { liveSessionsFor, liveCounts } from '../../src/renderer/state'
import type { Session } from '@shared/types'

const sessions: Session[] = [
  { id: 'a', projectId: 'p1', provider: 'codex', model: 'm', objective: 'a', status: 'running', createdAt: 0, updatedAt: 0 },
  { id: 'b', projectId: 'p1', provider: 'claude', model: 'm', objective: 'b', status: 'archived', createdAt: 0, updatedAt: 0 },
  { id: 'c', projectId: 'p1', provider: 'gemini', model: 'm', objective: 'c', status: 'idle', createdAt: 0, updatedAt: 0 },
  { id: 'd', projectId: 'p2', provider: 'codex', model: 'm', objective: 'd', status: 'running', createdAt: 0, updatedAt: 0 }
]

describe('liveSessionsFor (Close + Archive regression)', () => {
  it('excludes archived sessions from a project view', () => {
    const live = liveSessionsFor(sessions, 'p1')
    const ids = live.map((s) => s.id)
    expect(ids).toContain('a')
    expect(ids).toContain('c')
    expect(ids).not.toContain('b') // archived must not appear in the cockpit
  })
  it('scopes to the given project', () => {
    expect(liveSessionsFor(sessions, 'p2').map((s) => s.id)).toEqual(['d'])
  })
})

describe('liveCounts', () => {
  it('counts non-archived sessions per project', () => {
    expect(liveCounts(sessions)).toEqual({ p1: 2, p2: 1 })
  })
})
