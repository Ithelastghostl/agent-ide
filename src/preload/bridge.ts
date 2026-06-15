import { contextBridge, ipcRenderer } from 'electron'

// The single bridge between renderer and main. Real methods are added as
// layers land (pty in L2, projects in L4, etc.). Renderer has no direct
// Node access — everything OS-facing goes through window.agentIDE.
contextBridge.exposeInMainWorld('agentIDE', {
  ping: () => ipcRenderer.invoke('ping')
})
