export const PROVIDERS = ['codex', 'claude', 'gemini'] as const
export type Provider = typeof PROVIDERS[number]

export function isProvider(x: string): x is Provider {
  return (PROVIDERS as readonly string[]).includes(x)
}

/** A plain-shell session (no agent) is identified by its id prefix. */
export function isTerminalSession(id: string): boolean {
  return id.startsWith('term-')
}

export type SessionStatus = 'running' | 'idle' | 'archived'

export interface Model {
  id: string
  label: string
  tier: 'fast' | 'balanced' | 'max'
}

export interface Session {
  id: string
  projectId: string
  provider: Provider
  model: string
  objective: string
  status: SessionStatus
  createdAt: number
  updatedAt: number
}

export interface Project {
  id: string
  name: string
  repo: string // owner/name
  localPath: string
  hasDevcontainer: boolean
}

/** A library item — a Prompt, Skill, or Workflow read from the GitHub-backed
 *  library folder. `relPath` is the item's path relative to the library root
 *  (used for confined reads); `path` is the absolute path for display/debug. */
export type LibraryCategory = 'prompts' | 'skills' | 'workflows'

export interface LibraryItem {
  category: LibraryCategory
  name: string
  description: string
  relPath: string
  path: string
}

export interface LibraryContents {
  prompts: LibraryItem[]
  skills: LibraryItem[]
  workflows: LibraryItem[]
}
