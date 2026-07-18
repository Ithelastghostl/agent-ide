import { EventEmitter } from 'node:events'
import type { ExitReason } from './ptyManager'

/** The session lifecycle bus (P0.A). launchService + Store emit; attention (S5),
 *  queue (S6), cost (S5) subscribe. One process-wide instance — sessions are
 *  process-global, like the pty manager. */
export interface SessionEventMap {
  spawned: { id: string; projectId: string }
  output: { id: string; chunk: string }
  exit: { id: string; reason: ExitReason }
  archived: { id: string; projectId: string }
  stageChanged: { id: string }
}

class SessionEventBus extends EventEmitter {
  emitEvent<K extends keyof SessionEventMap>(event: K, payload: SessionEventMap[K]): void {
    this.emit(event, payload)
  }
  onEvent<K extends keyof SessionEventMap>(event: K, fn: (p: SessionEventMap[K]) => void): () => void {
    this.on(event, fn as (p: unknown) => void)
    return () => this.off(event, fn as (p: unknown) => void)
  }
}

export const sessionEvents = new SessionEventBus()
