/// <reference types="vite/client" />

// Allow side-effect CSS imports in the renderer (Vite bundles them; tsc needs this).
declare module '*.css'

// The preload bridge surface available on window.
interface AgentIDEBridge {
  ping(): Promise<string>
  modelsAll(): Promise<Record<string, { id: string; label: string; tier: string }[]>>
  sessionLaunch(req: {
    projectId: string; provider: string; model: string; objective: string; cwd: string; useContainer: boolean; importConfig?: boolean
  }): Promise<import('@shared/types').Session>
  sessionRename(id: string, name: string): Promise<void>
  sessionArchive(id: string): Promise<void>
  terminalOpen(req: { projectId: string; cwd: string; name: string; useContainer: boolean }): Promise<import('@shared/types').Session>
  containerStart(projectId: string, workspace: string, importConfig: boolean): Promise<string>
  containerStatus(projectId: string): Promise<'running' | 'stopped'>
  onContainerStatus(cb: (p: { projectId: string; state: 'starting' | 'running' | 'error' }) => void): void
  providerHealth(provider: string, projectId: string): Promise<'healthy' | 'not-logged-in' | 'not-installed' | 'unknown'>
  providerLogin(provider: string, projectId: string, cwd: string): Promise<string>
  providerInstall(provider: string, projectId: string): Promise<'healthy' | 'not-logged-in' | 'not-installed' | 'unknown'>
  githubRepos(): Promise<{ repo: string; name: string }[]>
  openDirectory(): Promise<string | null>
  projectsAddGithub(repo: string, parentDir?: string): Promise<import('@shared/types').Project>
  projectsAddLocal(localPath: string): Promise<import('@shared/types').Project>
  projectsAddUrl(url: string, parentDir: string): Promise<import('@shared/types').Project>
  projectsList(): Promise<import('@shared/types').Project[]>
  fsTree(root: string): Promise<{ name: string; dir: boolean; depth: number }[]>
  ptySpawn(o: { id: string; shell: string; args: string[]; cwd: string; env: Record<string, string> }): Promise<string>
  ptyWrite(id: string, data: string): void
  ptyResize(id: string, cols: number, rows: number): void
  ptyKill(id: string): void
  onPtyData(cb: (p: { id: string; data: string }) => void): void
  onSessionExit(cb: (p: { id: string; reason: 'closed' | 'crashed' }) => void): void
  sessionsAll(): Promise<import('@shared/types').Session[]>
  sessionResume(s: import('@shared/types').Session, cwd: string): Promise<import('@shared/types').Session>
}

interface Window {
  agentIDE: AgentIDEBridge
}
