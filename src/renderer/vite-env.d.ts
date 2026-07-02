/// <reference types="vite/client" />

// Allow side-effect CSS imports in the renderer (Vite bundles them; tsc needs this).
declare module '*.css'

// The preload bridge surface available on window.
interface AgentIDEBridge {
  ping(): Promise<string>
  openExternal(url: string, sessionId?: string): Promise<boolean>
  modelsAll(): Promise<Record<import('@shared/types').Provider, import('@shared/types').Model[]>>
  sessionLaunch(req: {
    projectId: string; provider: string; model: string; objective: string; cwd: string; useContainer: boolean; importConfig?: boolean
    taskKind?: import('@shared/types').TaskKind; taskSubkind?: import('@shared/types').TaskSubkind
  }): Promise<import('@shared/types').Session>
  sessionRename(id: string, name: string): Promise<void>
  sessionArchive(id: string): Promise<void>
  taskSetStatus(id: string, to: string): Promise<{ ok?: true; logPath?: string; error?: string }>
  taskGenerateTicket(id: string): Promise<{ ok?: true; ticketId?: string; ticketPath?: string; error?: string }>
  logTickets(projectId: string): Promise<import('@shared/types').Ticket[]>
  terminalOpen(req: { projectId: string; cwd: string; name: string; useContainer: boolean }): Promise<import('@shared/types').Session>
  containerStart(projectId: string, workspace: string, importConfig: boolean): Promise<string>
  containerStatus(projectId: string, workspace: string): Promise<'running' | 'stopped' | 'none'>
  onContainerStatus(cb: (p: { projectId: string; state: 'starting' | 'running' | 'error' }) => void): void
  providerHealth(provider: string, projectId: string, cwd: string): Promise<'healthy' | 'not-logged-in' | 'not-installed' | 'unknown'>
  providerLogin(provider: string, projectId: string, cwd: string): Promise<string>
  providerInstall(provider: string, projectId: string, cwd: string): Promise<'healthy' | 'not-logged-in' | 'not-installed' | 'unknown'>
  githubRepos(): Promise<{ repo: string; name: string }[]>
  openDirectory(): Promise<string | null>
  projectsAddGithub(repo: string, parentDir?: string): Promise<import('@shared/types').Project>
  projectsAddLocal(localPath: string): Promise<import('@shared/types').Project>
  projectsAddUrl(url: string, parentDir: string): Promise<import('@shared/types').Project>
  projectsList(): Promise<import('@shared/types').Project[]>
  fsTree(projectId: string): Promise<{ nodes: { name: string; dir: boolean; depth: number }[]; truncated: boolean }>
  fsDir(projectId: string, path: string): Promise<{ nodes: { name: string; dir: boolean; depth: number }[]; truncated: boolean }>
  fileRead(projectId: string, path: string): Promise<{ content?: string; error?: string }>
  fileWrite(projectId: string, path: string, content: string): Promise<{ ok?: true; error?: string }>
  ptyWrite(id: string, data: string): void
  ptyResize(id: string, cols: number, rows: number): void
  ptyKill(id: string): void
  onPtyData(cb: (p: { id: string; data: string }) => void): () => void
  onSessionExit(cb: (p: { id: string; reason: 'closed' | 'crashed' }) => void): void
  transcriptGet(id: string): Promise<string>
  libraryList(): Promise<import('@shared/types').LibraryContents>
  libraryRead(relPath: string): Promise<{ content?: string; error?: string }>
  libraryStatus(): Promise<{ dir: string; isClone: boolean; counts: { prompts: number; skills: number; workflows: number } }>
  librarySync(repo?: string): Promise<{ ok?: true; error?: string }>
  sessionsAll(): Promise<import('@shared/types').Session[]>
  sessionResume(s: import('@shared/types').Session, cwd: string, useContainer: boolean): Promise<import('@shared/types').Session>
  sessionChangeModel(s: import('@shared/types').Session, cwd: string, useContainer: boolean, provider: string, model: string): Promise<import('@shared/types').Session>
}

interface Window {
  agentIDE: AgentIDEBridge
}
