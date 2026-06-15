import { contextBridge, ipcRenderer } from 'electron'

// The single bridge between renderer and main. Renderer has no direct Node
// access — everything OS-facing goes through window.agentIDE.
contextBridge.exposeInMainWorld('agentIDE', {
  ping: () => ipcRenderer.invoke('ping'),

  // model registry + session launch
  modelsAll: () => ipcRenderer.invoke('models:all'),
  sessionLaunch: (req: unknown) => ipcRenderer.invoke('session:launch', req),
  sessionRename: (id: string, name: string) => ipcRenderer.invoke('session:rename', id, name),
  sessionArchive: (id: string) => ipcRenderer.invoke('session:archive', id),
  terminalOpen: (req: unknown) => ipcRenderer.invoke('terminal:open', req),

  // container lifecycle (F14)
  containerStart: (projectId: string, workspace: string, importConfig: boolean) => ipcRenderer.invoke('container:start', projectId, workspace, importConfig),
  containerStatus: (projectId: string, workspace: string) => ipcRenderer.invoke('container:status', projectId, workspace),
  onContainerStatus: (cb: (p: { projectId: string; state: 'starting' | 'running' | 'error' }) => void) =>
    ipcRenderer.on('container:status', (_e, p) => cb(p)),

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

  // terminal / session pty
  ptySpawn: (o: unknown) => ipcRenderer.invoke('pty:spawn', o),
  ptyWrite: (id: string, data: string) => ipcRenderer.send('pty:write', id, data),
  ptyResize: (id: string, cols: number, rows: number) => ipcRenderer.send('pty:resize', id, cols, rows),
  ptyKill: (id: string) => ipcRenderer.send('pty:kill', id),
  onPtyData: (cb: (p: { id: string; data: string }) => void) =>
    ipcRenderer.on('pty:data', (_e, p) => cb(p)),
  onSessionExit: (cb: (p: { id: string; reason: 'closed' | 'crashed' }) => void) =>
    ipcRenderer.on('session:exit', (_e, p) => cb(p)),

  // sessions persistence / global board
  sessionsAll: () => ipcRenderer.invoke('sessions:all'),
  sessionResume: (s: unknown, cwd: string) => ipcRenderer.invoke('session:resume', s, cwd)
})
