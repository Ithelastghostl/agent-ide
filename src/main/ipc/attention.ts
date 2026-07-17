import { ipcMain, Notification, BrowserWindow } from 'electron'
import type { IpcDeps } from './deps'
import { NOT_IMPLEMENTED } from './deps'
import { sessionEvents } from '../sessionEvents'
import { AttentionMonitor } from '../attention'
import type { CostSummary, Provider } from '../../shared/types'
import { isProvider } from '../../shared/types'

/** Attention monitor + cost telemetry (S5). Wires the ephemeral event-bus output
 *  monitor to renderer badges (session:attention / session:cost), an
 *  attention:state snapshot, cost:forSession, and one debounced OS notification
 *  per attention episode when the app is unfocused. session:handoff stays stubbed
 *  until S6. */
export function registerAttentionIpc(deps: IpcDeps): void {
  const { store, send } = deps

  const providerOf = (sessionId: string): Provider | undefined => {
    const p = store?.getSession(sessionId)?.provider
    return p && isProvider(p) ? p : undefined
  }

  // Persist a parsed cost summary. No dedicated Store.setSessionCost exists in the
  // frozen foundation, so update via getSession → saveSession (costJson is written
  // from Session.cost). Read-modify-write keeps the rest of the row intact.
  const saveCost = (sessionId: string, cost: CostSummary): void => {
    if (!store) return
    const s = store.getSession(sessionId)
    if (!s) return
    store.saveSession({ ...s, cost })
  }

  const isUnfocused = (): boolean => {
    const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
    if (wins.length === 0) return true // no window → treat as background
    return !wins.some((w) => w.isFocused())
  }

  const notify = (_sessionId: string, title: string, body: string): void => {
    // macOS Electron notification; guarded so a headless/unsupported host no-ops.
    try {
      if (typeof Notification !== 'undefined' && Notification.isSupported()) {
        new Notification({ title, body }).show()
      }
    } catch {
      /* notifications unavailable — badge still shows in-app */
    }
  }

  const monitor = new AttentionMonitor(
    {
      onAttention: (sessionId, state) => send('session:attention', { sessionId, state }),
      onCost: (sessionId) => send('session:cost', { sessionId })
    },
    { providerOf, saveCost, isUnfocused, notify }
  )

  // Subscribe to the session lifecycle bus (P0.A). Output feeds the buffered
  // line monitor; exit/archive drop ephemeral state.
  sessionEvents.onEvent('output', ({ id, chunk }) => monitor.onOutput(id, chunk))
  sessionEvents.onEvent('exit', ({ id }) => monitor.onExit(id))
  sessionEvents.onEvent('archived', ({ id }) => monitor.onExit(id))

  // Clear a flag when the user writes into a session (item 19: clear on pty:write).
  // ipcMain.on supports multiple listeners, so this coexists with the frozen
  // pty:write handler in ipc.ts without editing it.
  ipcMain.on('pty:write', (_e, id: string) => monitor.onInput(id))

  ipcMain.handle('attention:state', () => monitor.stateMap())
  ipcMain.handle('cost:forSession', (_e, sessionId: string) => {
    const live = monitor.costFor(sessionId)
    if (live) return live
    // Fall back to the persisted summary (survives a re-open with no new output).
    return store?.getSession(sessionId)?.cost ?? { error: 'unknown' }
  })
  ipcMain.handle('session:handoff', () => NOT_IMPLEMENTED)
}
