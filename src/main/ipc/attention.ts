import { ipcMain } from 'electron'
import type { IpcDeps } from './deps'
import { NOT_IMPLEMENTED } from './deps'
import { buildPrimer } from '../history'
import { addPendingReview } from './review'

/** Attention monitor + cost telemetry (S5) + split-view handoff (S6). The
 *  attention/cost handlers stay S5 stubs; S6 implements session:handoff here. */
export function registerAttentionIpc(deps: IpcDeps): void {
  const { store } = deps
  ipcMain.handle('attention:state', () => ({})) // {sessionId: 'input'|'idle'} — empty until S5
  ipcMain.handle('cost:forSession', () => NOT_IMPLEMENTED)

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
    // stripAnsi treats a bare CR as a TUI last-write-wins line rewrite, which
    // would drop the content of every CRLF-terminated line (a pty emits CRLF on
    // output). Normalise CRLF→LF first so plain conversation text survives while
    // genuine mid-line CR redraws are still collapsed by stripAnsi.
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
