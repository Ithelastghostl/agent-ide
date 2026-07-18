import { contextBridge, ipcRenderer } from 'electron'

// The single bridge between renderer and main. Renderer has no direct Node
// access — everything OS-facing goes through window.agentIDE.
contextBridge.exposeInMainWorld('agentIDE', {
  ping: () => ipcRenderer.invoke('ping'),

  // Open a URL in the host's default browser (host-side; works from containers).
  // Pass the originating sessionId so main can forward a container localhost port
  // out to the host before opening (OAuth callbacks, in-container dev servers).
  openExternal: (url: string, sessionId?: string): Promise<boolean> =>
    ipcRenderer.invoke('shell:openExternal', url, sessionId),

  // model registry + session launch
  modelsAll: () => ipcRenderer.invoke('models:all'),
  sessionLaunch: (req: unknown) => ipcRenderer.invoke('session:launch', req),
  sessionRename: (id: string, name: string) => ipcRenderer.invoke('session:rename', id, name),
  sessionArchive: (id: string) => ipcRenderer.invoke('session:archive', id),
  // M-LOG-a: advance a task's lifecycle (open→finished→deployed→ticketed). Marking
  // a product chat 'finished' writes its raw log entry in main.
  taskSetStatus: (id: string, to: string) => ipcRenderer.invoke('task:setStatus', id, to),
  // M-LOG-b: generate a roadmap ticket for a deployed product chat (headless
  // addendum pass); crash-safe with retry. And the project Log list (tickets).
  taskGenerateTicket: (id: string) => ipcRenderer.invoke('task:generateTicket', id),
  logTickets: (projectId: string) => ipcRenderer.invoke('log:tickets', projectId),
  terminalOpen: (req: unknown) => ipcRenderer.invoke('terminal:open', req),

  // container lifecycle (F14)
  containerStart: (projectId: string, workspace: string, importConfig: boolean) =>
    ipcRenderer.invoke('container:start', projectId, workspace, importConfig),
  containerStatus: (projectId: string, workspace: string) =>
    ipcRenderer.invoke('container:status', projectId, workspace),
  onContainerStatus: (cb: (p: { projectId: string; state: 'starting' | 'running' | 'error' }) => void) =>
    ipcRenderer.on('container:status', (_e, p) => cb(p)),

  // provider connection (F8/F9/F10). useContainer: explicit context wins in
  // main; omit for auto-detection.
  providerHealth: (provider: string, projectId: string, cwd: string, useContainer?: boolean) =>
    ipcRenderer.invoke('provider:health', provider, projectId, cwd, useContainer),
  providerLogin: (provider: string, projectId: string, cwd: string) =>
    ipcRenderer.invoke('provider:login', provider, projectId, cwd),
  providerInstall: (provider: string, projectId: string, cwd: string) =>
    ipcRenderer.invoke('provider:install', provider, projectId, cwd),

  // projects
  githubRepos: () => ipcRenderer.invoke('github:repos'),
  openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  projectsAddGithub: (repo: string, parentDir?: string) =>
    ipcRenderer.invoke('projects:addGithub', repo, parentDir),
  projectsAddLocal: (localPath: string) => ipcRenderer.invoke('projects:addLocal', localPath),
  projectsAddUrl: (url: string, parentDir: string) => ipcRenderer.invoke('projects:addUrl', url, parentDir),
  projectsList: () => ipcRenderer.invoke('projects:list'),
  // Files are addressed by projectId (main resolves the confined root, B1) — the
  // renderer never sends a filesystem path as the confinement root.
  fsTree: (projectId: string) => ipcRenderer.invoke('fs:tree', projectId),
  fsDir: (projectId: string, path: string) => ipcRenderer.invoke('fs:dir', projectId, path),
  fileRead: (projectId: string, path: string) => ipcRenderer.invoke('file:read', projectId, path),
  fileWrite: (projectId: string, path: string, content: string) =>
    ipcRenderer.invoke('file:write', projectId, path, content),

  // terminal / session pty. No raw spawn from the renderer (NN0): ptys are
  // started in main via session:launch / terminal:open / session:resume.
  ptyWrite: (id: string, data: string) => ipcRenderer.send('pty:write', id, data),
  ptyResize: (id: string, cols: number, rows: number) => ipcRenderer.send('pty:resize', id, cols, rows),
  ptyKill: (id: string) => ipcRenderer.send('pty:kill', id),
  // Returns an unsubscribe function so callers can remove the listener on
  // unmount (avoids leaking one global listener per mounted terminal).
  onPtyData: (cb: (p: { id: string; data: string }) => void) => {
    const h = (_e: unknown, p: { id: string; data: string }) => cb(p)
    ipcRenderer.on('pty:data', h)
    return () => ipcRenderer.removeListener('pty:data', h)
  },
  onSessionExit: (cb: (p: { id: string; reason: 'closed' | 'crashed' }) => void) =>
    ipcRenderer.on('session:exit', (_e, p) => cb(p)),
  // App-level notices from main (e.g. a container missing credential mounts).
  onNotice: (cb: (p: { message: string }) => void) => ipcRenderer.on('app:notice', (_e, p) => cb(p)),

  // Replay saved terminal output for a session (chat history) on mount.
  transcriptGet: (id: string): Promise<string> => ipcRenderer.invoke('transcript:get', id),

  // Library (Prompts/Skills/Workflows/Agents; local-first, optionally a clone).
  libraryList: () => ipcRenderer.invoke('library:list'),
  libraryRead: (relPath: string) => ipcRenderer.invoke('library:read', relPath),
  libraryStatus: () => ipcRenderer.invoke('library:status'),
  librarySync: (repo?: string) => ipcRenderer.invoke('library:sync', repo),
  libraryAddAgent: (input: unknown) => ipcRenderer.invoke('library:addAgent', input),

  // Commit+push the IDE-owned history repo (B8); returns per-step results.
  historySync: (timestamp: string) => ipcRenderer.invoke('history:sync', timestamp),

  // Whether a live pty exists for a session (reattach instead of respawn).
  ptyAlive: (id: string): Promise<boolean> => ipcRenderer.invoke('pty:alive', id),

  // sessions persistence / global board
  sessionsAll: () => ipcRenderer.invoke('sessions:all'),
  sessionResume: (s: unknown, cwd: string, useContainer: boolean) =>
    ipcRenderer.invoke('session:resume', s, cwd, useContainer),
  // Move a session's conversation to a different engine: relaunches the same
  // session id under a new provider/model and seeds it with the prior history.
  sessionChangeModel: (s: unknown, cwd: string, useContainer: boolean, provider: string, model: string) =>
    ipcRenderer.invoke('session:resume', s, cwd, useContainer, { provider, model }),

  // ============ v2 backlog-driven harness (predeclared for all streams) =====

  // Backlog (S1). CRUD + session binding. Source authority enforced in main.
  backlogList: (projectId: string) => ipcRenderer.invoke('backlog:list', projectId),
  backlogCreate: (input: unknown) => ipcRenderer.invoke('backlog:create', input),
  backlogUpdate: (input: unknown) => ipcRenderer.invoke('backlog:update', input),
  backlogDelete: (id: string) => ipcRenderer.invoke('backlog:delete', id),
  backlogForSession: (sessionId: string) => ipcRenderer.invoke('backlog:forSession', sessionId),
  backlogUnbind: (sessionId: string, itemId: string) =>
    ipcRenderer.invoke('backlog:unbind', sessionId, itemId),

  // Queue (S6). CRUD + explicit advancement.
  queueList: (projectId: string) => ipcRenderer.invoke('queue:list', projectId),
  queueEnqueue: (item: unknown) => ipcRenderer.invoke('queue:enqueue', item),
  queueDelete: (id: string) => ipcRenderer.invoke('queue:delete', id),
  queueReorder: (projectId: string, orderedIds: string[]) =>
    ipcRenderer.invoke('queue:reorder', projectId, orderedIds),
  queueStartNext: (projectId: string) => ipcRenderer.invoke('queue:startNext', projectId),
  queueGetAutoAdvance: (projectId: string) => ipcRenderer.invoke('queue:getAutoAdvance', projectId),
  queueSetAutoAdvance: (projectId: string, on: boolean) =>
    ipcRenderer.invoke('queue:setAutoAdvance', projectId, on),
  onQueueChanged: (cb: (p: { projectId: string }) => void) =>
    ipcRenderer.on('queue:changed', (_e, p) => cb(p)),

  // Harness (S3). Uniform CLAUDE.md-style protocol.
  harnessGet: () => ipcRenderer.invoke('harness:get'),
  harnessSet: (text: string) => ipcRenderer.invoke('harness:set', text),

  // Session stage / model (S3). Declarative desired-state writes.
  sessionSetStage: (id: string, stage: string) => ipcRenderer.invoke('session:setStage', id, stage),
  sessionSetModel: (id: string, provider: string, model: string) =>
    ipcRenderer.invoke('session:setModel', id, provider, model),

  // Search (S7). Cross-session FTS.
  searchQuery: (query: string, limit?: number) => ipcRenderer.invoke('search:query', query, limit),

  // Pending review (S6/S2). Never auto-submitted; inserted only on user action.
  reviewPending: (sessionId: string) => ipcRenderer.invoke('review:pending', sessionId),
  reviewInsert: (sessionId: string) => ipcRenderer.invoke('review:insert', sessionId),
  onReviewChanged: (cb: (p: { sessionId: string }) => void) =>
    ipcRenderer.on('review:changed', (_e, p) => cb(p)),

  // Git awareness + diff (S4). Read-only this run.
  gitStatus: (projectId: string) => ipcRenderer.invoke('git:status', projectId),
  gitDiff: (projectId: string, sessionId?: string) => ipcRenderer.invoke('git:diff', projectId, sessionId),
  snapshotList: (projectId: string) => ipcRenderer.invoke('snapshot:list', projectId),
  gitRollbackPreview: (snapshotId: string) => ipcRenderer.invoke('git:rollbackPreview', snapshotId),
  gitRollbackApply: (previewToken: string) => ipcRenderer.invoke('git:rollbackApply', previewToken),

  // Attention + cost (S5).
  attentionState: () => ipcRenderer.invoke('attention:state'),
  costForSession: (sessionId: string) => ipcRenderer.invoke('cost:forSession', sessionId),
  onAttention: (cb: (p: { sessionId: string; state: 'input' | 'idle' | null }) => void) =>
    ipcRenderer.on('session:attention', (_e, p) => cb(p)),
  onCost: (cb: (p: { sessionId: string }) => void) => ipcRenderer.on('session:cost', (_e, p) => cb(p)),

  // Split-view handoff (S6).
  sessionHandoff: (fromId: string, toId: string) => ipcRenderer.invoke('session:handoff', fromId, toId),

  // Linear (S2).
  linearStatus: (projectId: string) => ipcRenderer.invoke('linear:status', projectId),
  linearLink: (projectId: string, ref: unknown) => ipcRenderer.invoke('linear:link', projectId, ref),
  linearPull: (projectId: string) => ipcRenderer.invoke('linear:pull', projectId),
  linearWriteback: (itemId: string, action: unknown) =>
    ipcRenderer.invoke('linear:writeback', itemId, action),
  linearLogout: (accountId: string) => ipcRenderer.invoke('linear:logout', accountId)
})
