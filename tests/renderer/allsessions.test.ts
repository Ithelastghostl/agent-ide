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
  { id: 's3', projectId: 'p2', provider: 'gemini', model: 'pro', objective: 'Parse', status: 'idle', createdAt: 3, updatedAt: 3 },
  { id: 's4', projectId: 'p1', provider: 'claude', model: 'haiku', objective: 'Old archived', status: 'archived', createdAt: 0, updatedAt: 0 }
]

describe('AllSessions (NN4 global board)', () => {
  it('renders only LIVE sessions across projects, grouped by project (archived hidden)', () => {
    const el = AllSessions({ projects, sessions, onOpen: () => {} })
    expect(el.querySelectorAll('.as-proj').length).toBe(2)
    // 3 live sessions; the archived s4 is excluded.
    expect(el.querySelectorAll('.as-row').length).toBe(3)
    expect(el.textContent).not.toContain('Old archived')
    expect(el.querySelector('.sub')?.textContent).toContain('3 live')
  })

  it('orders sessions most-recent first within a project', () => {
    let opened: { projectId: string; sessionId: string } | null = null
    const el = AllSessions({ projects, sessions, onOpen: (projectId, sessionId) => { opened = { projectId, sessionId } } })
    // Within p1, s2 (createdAt 2) is newer than s1 (createdAt 1) → s2 renders first.
    const firstRow = el.querySelector('.as-row') as HTMLElement
    firstRow.click()
    expect(opened!.sessionId).toBe('s2')
    expect(opened!.projectId).toBe('p1')
  })
})
