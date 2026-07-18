import * as pty from 'node-pty'
import { existsSync, statSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'

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

/** The shell for HOST terminal sessions: the user's own shell, not a hardcoded
 *  bash (macOS ships bash 3.2 and defaults to zsh). Container terminals keep
 *  bash — containers are Linux. GUI launches may lack SHELL, so fall back to
 *  the passwd entry, then a platform default. */
export function hostShell(env: Record<string, string | undefined> = process.env): string {
  if (env.SHELL) return env.SHELL
  try {
    const s = userInfo().shell
    if (s) return s
  } catch {
    /* no passwd entry available */
  }
  return process.platform === 'darwin' ? '/bin/zsh' : 'bash'
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
  // B3: per-id generation token. Each spawn for an id bumps its generation; a
  // proc's onExit closure captures the generation it was born under and only acts
  // if it is still current. This prevents a replaced (old) proc's async exit from
  // archiving/idling the new same-id session — the classic pty generation race.
  private gen = new Map<string, number>()

  spawn(
    o: SpawnOpts,
    onData: (d: string) => void,
    onExit?: (info: { exitCode: number; signal?: number; reason: ExitReason }) => void
  ): string {
    // Replacing an existing id (e.g. reconnect): kill the old process first so
    // it isn't leaked (Codex P2). We do NOT mark it killed: bumping the
    // generation below makes the old proc's exit a no-op (it returns early on the
    // generation mismatch), so its reason no longer matters and a stale 'killed'
    // flag must not leak onto the new generation's classification.
    const prev = this.procs.get(o.id)
    if (prev) {
      try {
        prev.kill()
      } catch {
        /* already dead */
      }
    }
    const myGen = (this.gen.get(o.id) ?? 0) + 1
    this.gen.set(o.id, myGen)
    const proc = pty.spawn(o.shell, o.args, {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd: resolveCwd(o.cwd),
      env: { ...process.env, ...o.env } as Record<string, string>
    })
    proc.onData(onData)
    proc.onExit(({ exitCode, signal }) => {
      // Stale exit from a replaced proc: a newer generation already owns this id,
      // so ignore it entirely — don't reclassify, delete, or notify the caller.
      if (this.gen.get(o.id) !== myGen) return
      const reason = classifyExit(this.killed.has(o.id))
      this.killed.delete(o.id)
      this.procs.delete(o.id)
      this.gen.delete(o.id)
      onExit?.({ exitCode, signal, reason })
    })
    this.procs.set(o.id, proc)
    return o.id
  }

  write(id: string, data: string): void {
    this.procs.get(id)?.write(data)
  }

  /** B12: write `data` (a history primer) to a session once its terminal looks
   *  ready, instead of on a blind fixed delay. Readiness heuristic: after the
   *  first output, wait for `quietMs` of no further output (the TUI finished its
   *  initial render), with a `maxWaitMs` hard cap so it always fires. The deferred
   *  write is tied to the pty's CURRENT generation and is dropped if the session
   *  is killed or replaced before it fires — so a primer never lands in a dead pty
   *  or the wrong (new) session, and never interleaves mid-initial-render. */
  primeWhenReady(id: string, data: string, opts: { quietMs?: number; maxWaitMs?: number } = {}): void {
    const proc = this.procs.get(id)
    if (!proc) return
    const myGen = this.gen.get(id)
    const quietMs = opts.quietMs ?? 400
    const maxWaitMs = opts.maxWaitMs ?? 3000
    let quietTimer: ReturnType<typeof setTimeout> | null = null
    let done = false

    const dataSub = proc.onData(() => {
      if (done) return
      if (quietTimer) clearTimeout(quietTimer)
      quietTimer = setTimeout(fire, quietMs) // reset the quiet window on each burst
    })
    const hardCap = setTimeout(fire, maxWaitMs)

    function cleanup(): void {
      done = true
      if (quietTimer) clearTimeout(quietTimer)
      clearTimeout(hardCap)
      try {
        dataSub.dispose()
      } catch {
        /* already disposed */
      }
    }

    const self = this
    function fire(): void {
      if (done) return
      cleanup()
      // Only write if this exact generation is still the live one and not killed.
      if (self.gen.get(id) !== myGen || self.killed.has(id) || !self.procs.has(id)) return
      try {
        self.procs.get(id)?.write(data)
      } catch {
        /* pty gone */
      }
    }
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
