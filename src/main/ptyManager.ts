import * as pty from 'node-pty'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'

export interface SpawnOpts {
  id: string
  shell: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

/** Resolve a usable working directory, falling back to home if the path is
 *  missing (e.g. a stale project path or an unprovisioned mock). */
export function resolveCwd(cwd: string): string {
  try {
    if (cwd && existsSync(cwd) && statSync(cwd).isDirectory()) return cwd
  } catch {
    /* fall through */
  }
  return homedir()
}

/** How a pty session ended: 'closed' = user/IDE killed it; 'crashed' = the
 *  process exited on its own (unexpected). Both retain history (F4 + item 7). */
export type ExitReason = 'closed' | 'crashed'

/** Classify a pty exit. A user-initiated kill is 'closed'; anything else
 *  (non-zero code, a signal, or an unexpected clean exit) is 'crashed'. */
export function classifyExit(userKilled: boolean): ExitReason {
  return userKilled ? 'closed' : 'crashed'
}

/** Owns all node-pty child processes (one per session). Main-process only. */
export class PtyManager {
  private procs = new Map<string, pty.IPty>()
  private killed = new Set<string>()

  spawn(
    o: SpawnOpts,
    onData: (d: string) => void,
    onExit?: (info: { exitCode: number; signal?: number; reason: ExitReason }) => void
  ): string {
    const proc = pty.spawn(o.shell, o.args, {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd: resolveCwd(o.cwd),
      env: { ...process.env, ...o.env } as Record<string, string>
    })
    proc.onData(onData)
    proc.onExit(({ exitCode, signal }) => {
      const reason = classifyExit(this.killed.has(o.id))
      this.killed.delete(o.id)
      this.procs.delete(o.id)
      onExit?.({ exitCode, signal, reason })
    })
    this.procs.set(o.id, proc)
    return o.id
  }

  write(id: string, data: string): void {
    this.procs.get(id)?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    this.procs.get(id)?.resize(cols, rows)
  }

  /** Explicit close: marks the id so its exit is classified 'closed'. */
  kill(id: string): void {
    const proc = this.procs.get(id)
    if (!proc) return
    this.killed.add(id)
    proc.kill()
  }

  has(id: string): boolean {
    return this.procs.has(id)
  }
}
