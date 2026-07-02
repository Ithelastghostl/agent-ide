import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { createRuntime } from './runtime'
import { registerIpc, safeOpenExternal } from './ipc'
import { Store } from './store'

// R1 / Linux-Wayland note: on a Wayland session (Ubuntu 24.04+ default), Electron
// 42's Wayland ozone backend is incompatible with Vulkan and SIGSEGVs at startup
// in wayland_surface_factory.cc ("'--ozone-platform=wayland' is not compatible
// with Vulkan"). This was the historical "Electron 42 crashes on this box"
// blocker — NOT a kernel/upstream regression. The fix is to run the X11 ozone
// backend (via XWayland on Wayland sessions). It MUST be applied as a real launch
// argument (`--ozone-platform=x11`) or by stripping WAYLAND_DISPLAY before the
// process starts — ozone selects its backend in native code before this main
// module executes, so app.commandLine.appendSwitch() here is too late and is
// overridden by a present WAYLAND_DISPLAY. The launch sites therefore pass the
// flag: dev/start via the npm scripts, e2e via the Playwright launch args, and
// the packaged app via its launcher (M5). See scripts/linux-launch note.

// Display name shown in the taskbar / window manager (distinct from the npm
// package id "agent-ide", which stays as the data-dir/package identifier).
app.setName("Nacho's IDE")

// M1: the platform runtime (Linux impl in the beta). All node-pty/docker/host
// side effects go through this; ipc.ts is platform-agnostic above it.
const runtime = createRuntime()

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 880,
    backgroundColor: '#000101',
    title: "Nacho's IDE",
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
  // Deny window.open / target=_blank and hand safe URLs to the OS instead — via
  // the single safeOpenExternal choke point (S-URL).
  win.webContents.setWindowOpenHandler(({ url }) => {
    safeOpenExternal(url)
    return { action: 'deny' }
  })

  // Guard against in-place navigation to external URLs replacing the app UI.
  win.webContents.on('will-navigate', (event, url) => {
    const appUrl = process.env.ELECTRON_RENDERER_URL
    if (appUrl && url.startsWith(appUrl)) return
    event.preventDefault() // never navigate the app frame away
    safeOpenExternal(url)  // hand off iff safe (no-op otherwise)
  })

  registerIpc(runtime, win, store)

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
