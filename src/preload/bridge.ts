import { contextBridge, ipcRenderer } from 'electron'

// The single bridge between renderer and main. Renderer has no direct Node
// access — everything OS-facing goes through window.agentIDE.
contextBridge.exposeInMainWorld('agentIDE', {
  ping: () => ipcRenderer.invoke('ping'),

  // model registry + session launch
  modelsAll: () => ipcRenderer.invoke('models:all'),
  sessionLaunch: (req: unknown) => ipcRenderer.invoke('session:launch', req),

  // projects (GitHub-synced)
  githubRepos: () => ipcRenderer.invoke('github:repos'),
  projectsAdd: (repo: string) => ipcRenderer.invoke('projects:add', repo),
  fsTree: (root: string) => ipcRenderer.invoke('fs:tree', root),

  // terminal / session pty
  ptySpawn: (o: unknown) => ipcRenderer.invoke('pty:spawn', o),
  ptyWrite: (id: string, data: string) => ipcRenderer.send('pty:write', id, data),
  ptyResize: (id: string, cols: number, rows: number) => ipcRenderer.send('pty:resize', id, cols, rows),
  ptyKill: (id: string) => ipcRenderer.send('pty:kill', id),
  onPtyData: (cb: (p: { id: string; data: string }) => void) =>
    ipcRenderer.on('pty:data', (_e, p) => cb(p))
})
