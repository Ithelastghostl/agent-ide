import { ipcMain, Notification, BrowserWindow } from 'electron'
import type { IpcDeps } from './deps'
import { sessionEvents } from '../sessionEvents'
import { AttentionMonitor } from '../attention'
import type { CostSummary, Provider } from '../../shared/types'
import { isProvider } from '../../shared/types'
import { buildPrimer } from '../history'
import { addPendingReview } from './review'

/** Attention monitor + cost telemetry (S5) + split-view handoff (S6). Wires the
 *  ephemeral event-bus output monitor to renderer badges (session:attention /
 *  session:cost), an attention:state snapshot, cost:forSession, one debounced OS
 *  notification per attention episode when the app is unfocused; and S6's
 *  session:handoff (review-based, never auto-submitted). */
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

  // session:handoff(fromId, toId) — take the cleaned tail of session A's
  // conversation and register it as PENDING-REVIEW material for session B. It is
  // NEVER written to B's pty here (C-14/R6-4/R7): the renderer surfaces a
  // "Review & insert" affordance, and only review:insert bracket-pastes it (no
  // trailing newline, sentinel-wrapped, write-ahead logged). Reuses buildPrimer
  // (which applies stripAnsi) from history.ts so the tail is cleaned + tail-capped
  // identically to the resume/history primer.
  ipcMain.handle('session:handoff', (_e, fromId: unknown, toId: unknown) => {
    if (typeof fromId !== 'string' || typeof toId !== 'string') return { error: 'invalid request' }
    if (fromId === toId) return { error: 'cannot hand a session off to itself' }
    if (!store) return { error: 'no store' }
    const from = store.getSession(fromId)
    const to = store.getSession(toId)
    if (!from) return { error: 'source session not found' }
    if (!to) return { error: 'target session not found' }

    // Cleaned, tail-capped conversation of A (16k tail — the handoff cap, C-14).
    // buildPrimer strips ANSI (via stripAnsi) and keeps the most recent 16k chars;
    // if there's nothing worth handing off it returns '' and we refuse.
    // NOTE: the CRLF→LF normalisation here is now redundant with the canonical
    // stripAnsi fix in history.ts, but harmless — kept for locality.
    const raw = store.getTranscript(fromId).replace(/\r\n/g, '\n')
    const cleaned = buildPrimer(raw, 16_000)
    if (!cleaned.trim()) return { error: 'nothing to hand off (source has no transcript yet)' }

    // Register as review-trust material for B. This is held in the pending-review
    // store (ephemeral, R8) and delivered ONLY via review:insert. No pty write here.
    const label = `handoff from “${from.objective || fromId}”`
    addPendingReview(toId, label, cleaned)
    deps.send('review:changed', { sessionId: toId })

    // If B is in fix mode (effectiveStage 'fix'), the renderer shows a warning
    // banner BEFORE the insert affordance (fix mode auto-executes on submit).
    const targetInFix = (to.effectiveStage ?? to.desiredStage) === 'fix'
    return { ok: true, targetInFix }
  })
}
