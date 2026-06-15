/// <reference types="vite/client" />

// Allow side-effect CSS imports in the renderer (Vite bundles them; tsc needs this).
declare module '*.css'

// The preload bridge surface available on window.
interface AgentIDEBridge {
  ping(): Promise<string>
  modelsAll(): Promise<Record<string, { id: string; label: string; tier: string }[]>>
  sessionLaunch(req: {
    projectId: string; provider: string; model: string; objective: string; cwd: string; useContainer: boolean
  }): Promise<import('@shared/types').Session>
  githubRepos(): Promise<{ repo: string; name: string }[]>
  projectsAdd(repo: string): Promise<import('@shared/types').Project>
  fsTree(root: string): Promise<{ name: string; dir: boolean; depth: number }[]>
  ptySpawn(o: { id: string; shell: string; args: string[]; cwd: string; env: Record<string, string> }): Promise<string>
  ptyWrite(id: string, data: string): void
  ptyResize(id: string, cols: number, rows: number): void
  ptyKill(id: string): void
  onPtyData(cb: (p: { id: string; data: string }) => void): void
  onSessionArchived(cb: (p: { id: string }) => void): void
  sessionsAll(): Promise<import('@shared/types').Session[]>
  sessionResume(s: import('@shared/types').Session, cwd: string): Promise<import('@shared/types').Session>
}

interface Window {
  agentIDE: AgentIDEBridge
}
