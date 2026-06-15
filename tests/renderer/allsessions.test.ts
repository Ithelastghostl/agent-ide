// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { AllSessions } from '../../src/renderer/components/AllSessions'
import type { Project, Session } from '@shared/types'

const projects: Project[] = [
  { id: 'p1', name: 'sample-api', repo: 'example/sample-api', localPath: '/a', hasDevcontainer: true },
  { id: 'p2', name: 'sample-cli', repo: 'example/sample-cli', localPath: '/b', hasDevcontainer: false }
]
const sessions: Session[] = [
  { id: 's1', projectId: 'p1', provider: 'codex', model: 'gpt-5-codex', objective: 'Fix auth', status: 'running', createdAt: 1, updatedAt: 1 },
  { id: 's2', projectId: 'p1', provider: 'claude', model: 'sonnet', objective: 'Tests', status: 'running', createdAt: 2, updatedAt: 2 },
  { id: 's3', projectId: 'p2', provider: 'gemini', model: 'pro', objective: 'Parse', status: 'idle', createdAt: 3, updatedAt: 3 }
]

describe('AllSessions (NN4 global board)', () => {
  it('renders every session across all projects, grouped by project', () => {
    const el = AllSessions({ projects, sessions, onOpen: () => {} })
    // one group per project that has sessions
    expect(el.querySelectorAll('.as-proj').length).toBe(2)
    // one row per session (3 total)
    expect(el.querySelectorAll('.as-row').length).toBe(3)
  })

  it('clicking a session row opens it (project + session id)', () => {
    let opened: { projectId: string; sessionId: string } | null = null
    const el = AllSessions({ projects, sessions, onOpen: (projectId, sessionId) => { opened = { projectId, sessionId } } })
    ;(el.querySelector('.as-row') as HTMLElement).click()
    expect(opened).not.toBeNull()
    expect(opened!.sessionId).toBe('s1')
    expect(opened!.projectId).toBe('p1')
  })
})
