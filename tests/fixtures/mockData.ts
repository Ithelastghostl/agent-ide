import type { Project, Session } from '@shared/types'
import type { FileNode } from '../../src/renderer/components/Explorer'

// B13: sample data for tests/manual scaffolding. Moved here out of the renderer
// bundle (src/renderer/state.ts) — it was exported but unused at runtime, so it
// only bloated the shipped bundle. Import from tests when a fixture is needed.

export const mockProjects: Project[] = [
  {
    id: '1',
    name: 'sample-api',
    repo: 'example/sample-api',
    localPath: '/home/me/AgentIDE/sample-api',
    hasDevcontainer: true
  },
  {
    id: '2',
    name: 'sample-cli',
    repo: 'example/sample-cli',
    localPath: '/home/me/AgentIDE/sample-cli',
    hasDevcontainer: false
  },
  {
    id: '3',
    name: 'sample-web',
    repo: 'example/sample-web',
    localPath: '/home/me/AgentIDE/sample-web',
    hasDevcontainer: false
  }
]

export const mockSessions: Session[] = [
  {
    id: 's1',
    projectId: '1',
    provider: 'codex',
    model: 'gpt-5-codex',
    objective: 'Fix auth session race',
    status: 'running',
    createdAt: 0,
    updatedAt: 0
  },
  {
    id: 's2',
    projectId: '1',
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    objective: 'Write tests for billing',
    status: 'running',
    createdAt: 0,
    updatedAt: 0
  },
  {
    id: 's3',
    projectId: '1',
    provider: 'claude',
    model: 'claude-haiku-4-5',
    objective: 'Tidy button styles',
    status: 'archived',
    createdAt: 0,
    updatedAt: 0
  },
  {
    id: 's4',
    projectId: '1',
    provider: 'gemini',
    model: 'gemini-2.5-pro',
    objective: 'Summarize architecture',
    status: 'idle',
    createdAt: 0,
    updatedAt: 0
  },
  {
    id: 's5',
    projectId: '2',
    provider: 'codex',
    model: 'gpt-5-codex',
    objective: 'Parse input files',
    status: 'running',
    createdAt: 0,
    updatedAt: 0
  },
  {
    id: 's6',
    projectId: '3',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    objective: 'Chart tweaks',
    status: 'running',
    createdAt: 0,
    updatedAt: 0
  }
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
