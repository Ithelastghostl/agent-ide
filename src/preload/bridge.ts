import { contextBridge, ipcRenderer } from 'electron'

// The single bridge between renderer and main. Renderer has no direct Node
// access — everything OS-facing goes through window.agentIDE.
contextBridge.exposeInMainWorld('agentIDE', {
  ping: () => ipcRenderer.invoke('ping'),

  // Terminal copy/paste via the OS clipboard in main (the renderer's
  // navigator.clipboard silently no-ops without focus/activation).
  clipboardWrite: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:write', text),
  clipboardRead: (): Promise<string> => ipcRenderer.invoke('clipboard:read'),

  // Open a URL in the host's default browser (host-side; works from containers).
  // Pass the originating sessionId so main can forward a container localhost port
  // out to the host before opening (OAuth callbacks, in-container dev servers).
  openExternal: (url: string, sessionId?: string): Promise<boolean> => ipcRenderer.invoke('shell:openExternal', url, sessionId),

  // model registry + session launch
  modelsAll: () => ipcRenderer.invoke('models:all'),
  sessionLaunch: (req: unknown) => ipcRenderer.invoke('session:launch', req),
  sessionRename: (id: string, name: string) => ipcRenderer.invoke('session:rename', id, name),
  sessionArchive: (id: string) => ipcRenderer.invoke('session:archive', id),
  sessionDelete: (id: string) => ipcRenderer.invoke('session:delete', id),
  terminalOpen: (req: unknown) => ipcRenderer.invoke('terminal:open', req),

  // container lifecycle (F14)
  containerStart: (projectId: string, workspace: string, importConfig: boolean) => ipcRenderer.invoke('container:start', projectId, workspace, importConfig),
  containerStatus: (projectId: string, workspace: string) => ipcRenderer.invoke('container:status', projectId, workspace),
  containerStop: (projectId: string, workspace: string) => ipcRenderer.invoke('container:stop', projectId, workspace),
  onContainerStatus: (cb: (p: { projectId: string; state: 'none' | 'stopped' | 'starting' | 'running' | 'error' }) => void) =>
    ipcRenderer.on('container:status', (_e, p) => cb(p)),

  // external-service connectivity (status bar, F16)
  serviceHealth: () => ipcRenderer.invoke('service:health'),
  serviceLogin: (service: string, cwd: string) => ipcRenderer.invoke('service:login', service, cwd),

  // provider connection (F8/F9/F10)
  providerHealth: (provider: string, projectId: string, cwd: string) => ipcRenderer.invoke('provider:health', provider, projectId, cwd),
  providerLogin: (provider: string, projectId: string, cwd: string) => ipcRenderer.invoke('provider:login', provider, projectId, cwd),
  providerInstall: (provider: string, projectId: string, cwd: string) => ipcRenderer.invoke('provider:install', provider, projectId, cwd),

  // projects
  githubRepos: () => ipcRenderer.invoke('github:repos'),
  openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  projectsAddGithub: (repo: string, parentDir?: string) => ipcRenderer.invoke('projects:addGithub', repo, parentDir),
  projectsAddLocal: (localPath: string) => ipcRenderer.invoke('projects:addLocal', localPath),
  projectsAddUrl: (url: string, parentDir: string) => ipcRenderer.invoke('projects:addUrl', url, parentDir),
  projectsList: () => ipcRenderer.invoke('projects:list'),
  fsTree: (root: string) => ipcRenderer.invoke('fs:tree', root),
  fsDir: (root: string, path: string) => ipcRenderer.invoke('fs:dir', root, path),
  fileRead: (root: string, path: string) => ipcRenderer.invoke('file:read', root, path),
  fileWrite: (root: string, path: string, content: string) => ipcRenderer.invoke('file:write', root, path, content),

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

  // The chosen model was rejected by the provider (e.g. a Codex model not
  // available on a ChatGPT-account login). The session stays alive at its prompt;
  // the UI offers to pick another model.
  onSessionModelRejected: (cb: (p: { id: string; model: string; message: string }) => void) =>
    ipcRenderer.on('session:model-rejected', (_e, p) => cb(p)),

  // Replay saved terminal output for a session (chat history) on mount.
  transcriptGet: (id: string): Promise<string> => ipcRenderer.invoke('transcript:get', id),

  // sessions persistence / global board
  sessionsAll: () => ipcRenderer.invoke('sessions:all'),
  sessionResume: (s: unknown, cwd: string, useContainer: boolean) => ipcRenderer.invoke('session:resume', s, cwd, useContainer),
  // Move a session's conversation to a different engine: relaunches the same
  // session id under a new provider/model and seeds it with the prior history.
  sessionChangeModel: (s: unknown, cwd: string, useContainer: boolean, provider: string, model: string) =>
    ipcRenderer.invoke('session:resume', s, cwd, useContainer, { provider, model })
})
