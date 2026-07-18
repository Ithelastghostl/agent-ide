import { ipcMain } from 'electron'
import type { IpcDeps } from './deps'
import { reviewOpen, reviewClose } from '../launchPrimer'
import { randomUUID } from 'node:crypto'

// Pending-review state (R6-4/R22/R23): review (Linear/handoff) text is NEVER
// auto-submitted. It is held here per session and inserted only on explicit user
// action, wrapped in review sentinels + logged write-ahead so it can never be
// auto-resubmitted from history. Ephemeral across restarts (documented, R8).
interface Pending {
  sections: { label: string; text: string }[]
}
const pendingBySession = new Map<string, Pending>()

/** Queue review text for a session (called by S2/S6 when producing review-trust
 *  primer material). Exported so those streams can push into it. */
export function addPendingReview(sessionId: string, label: string, text: string): void {
  const p = pendingBySession.get(sessionId) ?? { sections: [] }
  p.sections.push({ label, text })
  pendingBySession.set(sessionId, p)
}

export function registerReviewIpc({ store, runtime, send }: IpcDeps): void {
  ipcMain.handle('review:pending', (_e, sessionId: unknown) => {
    if (typeof sessionId !== 'string') return { sections: [], totalChars: 0 }
    const p = pendingBySession.get(sessionId)
    if (!p) return { sections: [], totalChars: 0 }
    return {
      sections: p.sections.map((s) => ({ label: s.label, chars: s.text.length })),
      totalChars: p.sections.reduce((n, s) => n + s.text.length, 0)
    }
  })

  ipcMain.handle('review:insert', (_e, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || !store) return { error: 'invalid request' }
    const p = pendingBySession.get(sessionId)
    if (!p || !p.sections.length) return { error: 'nothing to insert' }
    if (!runtime.terminal.has(sessionId)) return { error: 'session is not live' }
    const body = p.sections.map((s) => s.text).join('\n\n')
    // WRITE-AHEAD the review insertion BEFORE any pty write (R23): if logging
    // throws, refuse the insertion so it can never enter trusted history unlogged.
    try {
      store.logReviewInsertion(sessionId, body)
    } catch (err) {
      return { error: 'could not record review: ' + (err as Error).message }
    }
    const id = randomUUID()
    // bracketed paste, NO trailing newline, wrapped in sentinels
    const payload = `\x1b[200~${reviewOpen(id)}${body}${reviewClose(id)}\x1b[201~`
    runtime.terminal.write(sessionId, payload)
    pendingBySession.delete(sessionId)
    send('review:changed', { sessionId })
    return { ok: true }
  })
}
