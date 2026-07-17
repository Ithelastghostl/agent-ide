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
    // S8: agent preset relPath; main validates + primes the agent body.
    agentRelPath?: string | null
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
  providerHealth(provider: string, projectId: string, cwd: string, useContainer?: boolean): Promise<'healthy' | 'not-logged-in' | 'not-installed' | 'unknown'>
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
  onNotice(cb: (p: { message: string }) => void): void
  transcriptGet(id: string): Promise<string>
  libraryList(): Promise<import('@shared/types').LibraryContents>
  libraryRead(relPath: string): Promise<{ content?: string; error?: string }>
  libraryStatus(): Promise<{ dir: string; isClone: boolean; counts: { prompts: number; skills: number; workflows: number; agents: number } }>
  librarySync(repo?: string): Promise<{ ok?: true; error?: string }>
  libraryAddAgent(input: import('@shared/types').AgentInput): Promise<{ relPath?: string; error?: string }>
  historySync(timestamp: string): Promise<{ step: 'add' | 'commit' | 'push'; ok: boolean; skipped?: boolean; error?: string }[]>
  ptyAlive(id: string): Promise<boolean>
  sessionsAll(): Promise<import('@shared/types').Session[]>
  sessionResume(s: import('@shared/types').Session, cwd: string, useContainer: boolean): Promise<import('@shared/types').Session>
  sessionChangeModel(s: import('@shared/types').Session, cwd: string, useContainer: boolean, provider: string, model: string): Promise<import('@shared/types').Session>

  // ---- v2 backlog-driven harness (predeclared for all streams) ----
  backlogList(projectId: string): Promise<import('@shared/types').BacklogItem[]>
  backlogCreate(input: import('@shared/types').BacklogCreateInput): Promise<{ item?: import('@shared/types').BacklogItem; error?: string }>
  backlogUpdate(input: import('@shared/types').BacklogUpdateInput): Promise<{ item?: import('@shared/types').BacklogItem; error?: string }>
  backlogDelete(id: string): Promise<{ ok?: true; error?: string }>
  backlogForSession(sessionId: string): Promise<string[]>
  backlogUnbind(sessionId: string, itemId: string): Promise<{ ok?: true; error?: string }>
  queueList(projectId: string): Promise<import('@shared/types').QueueItem[]>
  queueEnqueue(item: Partial<import('@shared/types').QueueItem>): Promise<{ item?: import('@shared/types').QueueItem; error?: string }>
  queueDelete(id: string): Promise<{ ok?: true; error?: string }>
  queueReorder(projectId: string, orderedIds: string[]): Promise<{ ok?: true; error?: string }>
  queueStartNext(projectId: string): Promise<{ ok?: true; sessionId?: string | null; error?: string }>
  queueGetAutoAdvance(projectId: string): Promise<boolean>
  queueSetAutoAdvance(projectId: string, on: boolean): Promise<{ ok?: true; autoAdvance?: boolean; error?: string }>
  onQueueChanged(cb: (p: { projectId: string }) => void): void
  harnessGet(): Promise<string>
  harnessSet(text: string): Promise<{ ok?: true; error?: string }>
  sessionSetStage(id: string, stage: string): Promise<{ ok?: true; error?: string }>
  sessionSetModel(id: string, provider: string, model: string): Promise<{ ok?: true; error?: string }>
  searchQuery(query: string, limit?: number): Promise<import('@shared/types').SearchHit[]>
  reviewPending(sessionId: string): Promise<{ sections: { label: string; chars: number }[]; totalChars: number }>
  reviewInsert(sessionId: string): Promise<{ ok?: true; error?: string }>
  onReviewChanged(cb: (p: { sessionId: string }) => void): void
  gitStatus(projectId: string): Promise<import('@shared/types').GitStatusSummary | { error: string }>
  gitDiff(projectId: string, sessionId?: string): Promise<import('@shared/types').GitDiff | { error: string }>
  snapshotList(projectId: string): Promise<import('@shared/types').Snapshot[] | { error: string }>
  gitRollbackPreview(snapshotId: string): Promise<import('@shared/types').RollbackPreview | { error: string }>
  gitRollbackApply(previewToken: string): Promise<{ ok?: true; error?: string }>
  attentionState(): Promise<Record<string, 'input' | 'idle'>>
  costForSession(sessionId: string): Promise<import('@shared/types').CostSummary | { error: string }>
  onAttention(cb: (p: { sessionId: string; state: 'input' | 'idle' | null }) => void): void
  onCost(cb: (p: { sessionId: string }) => void): void
  sessionHandoff(fromId: string, toId: string): Promise<{ ok?: true; targetInFix?: boolean; error?: string }>
  linearStatus(projectId: string): Promise<unknown>
  linearLink(projectId: string, ref: unknown): Promise<{ ok?: true; error?: string }>
  linearPull(projectId: string): Promise<{ ok?: true; count?: number; error?: string }>
  linearWriteback(itemId: string, action: unknown): Promise<{ ok?: true; error?: string }>
  linearLogout(accountId: string): Promise<{ ok?: true; error?: string }>
}

interface Window {
  agentIDE: AgentIDEBridge
}
