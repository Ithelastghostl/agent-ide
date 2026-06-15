import type { Project, Session } from '@shared/types'
import type { FileNode } from './components/Explorer'

/** L1 mock state. Replaced by real project/session data from the main process in L4/L6. */
export interface AppState {
  projects: Project[]
  sessions: Session[]
  currentProjectId: string
  activeSessionId: string | null
  view: 'cockpit' | 'home'
}

export const mockProjects: Project[] = [
  { id: '1', name: 'talentchain-api', repo: 'me/talentchain-api', localPath: '/home/me/AgentIDE/talentchain-api', hasDevcontainer: true },
  { id: '2', name: 'resume-parser', repo: 'me/resume-parser', localPath: '/home/me/AgentIDE/resume-parser', hasDevcontainer: false },
  { id: '3', name: 'growth-dash', repo: 'me/growth-dash', localPath: '/home/me/AgentIDE/growth-dash', hasDevcontainer: false }
]

export const mockSessions: Session[] = [
  { id: 's1', projectId: '1', provider: 'codex', model: 'gpt-5-codex', objective: 'Fix auth session race', status: 'running', createdAt: 0, updatedAt: 0 },
  { id: 's2', projectId: '1', provider: 'claude', model: 'claude-sonnet-4-6', objective: 'Write tests for billing', status: 'running', createdAt: 0, updatedAt: 0 },
  { id: 's3', projectId: '1', provider: 'claude', model: 'claude-haiku-4-5', objective: 'Tidy button styles', status: 'archived', createdAt: 0, updatedAt: 0 },
  { id: 's4', projectId: '1', provider: 'gemini', model: 'gemini-2.5-pro', objective: 'Summarize architecture', status: 'idle', createdAt: 0, updatedAt: 0 },
  { id: 's5', projectId: '2', provider: 'codex', model: 'gpt-5-codex', objective: 'Parse PDF resumes', status: 'running', createdAt: 0, updatedAt: 0 },
  { id: 's6', projectId: '3', provider: 'gemini', model: 'gemini-2.5-flash', objective: 'Chart tweaks', status: 'running', createdAt: 0, updatedAt: 0 }
]

export const mockTree: FileNode[] = [
  { name: 'src', dir: true, depth: 0 },
  { name: 'server.ts', dir: false, depth: 1 },
  { name: 'auth.ts', dir: false, depth: 1, modified: true },
  { name: 'db.ts', dir: false, depth: 1 },
  { name: '.devcontainer', dir: true, depth: 0 },
  { name: 'devcontainer.json', dir: false, depth: 1 },
  { name: 'package.json', dir: false, depth: 0 },
  { name: 'README.md', dir: false, depth: 0 }
]

export function initialState(): AppState {
  return {
    projects: mockProjects,
    sessions: mockSessions,
    currentProjectId: '1',
    activeSessionId: 's1',
    view: 'cockpit'
  }
}

/** Count of running/idle (non-archived) sessions per project — drives rail badges. */
export function liveCounts(sessions: Session[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const s of sessions) {
    if (s.status === 'archived') continue
    out[s.projectId] = (out[s.projectId] ?? 0) + 1
  }
  return out
}
