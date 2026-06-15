export const PROVIDERS = ['codex', 'claude', 'gemini'] as const
export type Provider = typeof PROVIDERS[number]

export function isProvider(x: string): x is Provider {
  return (PROVIDERS as readonly string[]).includes(x)
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
