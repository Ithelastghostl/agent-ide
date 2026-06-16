import { app, BrowserWindow, shell } from 'electron'
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

  // Links should open in the user's default browser, not a new Electron window.
  // Deny window.open / target=_blank and hand http(s) URLs to the OS instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) shell.openExternal(url)
    return { action: 'deny' }
  })

  // Guard against in-place navigation to external URLs replacing the app UI.
  win.webContents.on('will-navigate', (event, url) => {
    const appUrl = process.env.ELECTRON_RENDERER_URL
    if (appUrl && url.startsWith(appUrl)) return
    if (url.startsWith('http:') || url.startsWith('https:')) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })

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
