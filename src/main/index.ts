import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { PtyManager } from './ptyManager'
import { registerIpc } from './ipc'
import { Store } from './store'

const ptyManager = new PtyManager()

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 880,
    backgroundColor: '#000101',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/bridge.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Construct the store defensively: if better-sqlite3 fails to load (e.g. an
  // ABI mismatch from `npm test`), the app must still open with a usable UI
  // rather than a blank window. Persistence is degraded until fixed.
  let store: Store | undefined
  try {
    store = new Store()
  } catch (err) {
    console.error('Store init failed — running without persistence:', err)
  }

  registerIpc(ptyManager, win, store)

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(createWindow)

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
