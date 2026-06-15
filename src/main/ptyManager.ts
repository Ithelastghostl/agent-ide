import * as pty from 'node-pty'

export interface SpawnOpts {
  id: string
  shell: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

/** Owns all node-pty child processes (one per session). Main-process only. */
export class PtyManager {
  private procs = new Map<string, pty.IPty>()

  spawn(o: SpawnOpts, onData: (d: string) => void): string {
    const proc = pty.spawn(o.shell, o.args, {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd: o.cwd,
      env: { ...process.env, ...o.env } as Record<string, string>
    })
    proc.onData(onData)
    proc.onExit(() => this.procs.delete(o.id))
    this.procs.set(o.id, proc)
    return o.id
  }

  write(id: string, data: string): void {
    this.procs.get(id)?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    this.procs.get(id)?.resize(cols, rows)
  }

  kill(id: string): void {
    this.procs.get(id)?.kill()
    this.procs.delete(id)
  }

  has(id: string): boolean {
    return this.procs.has(id)
  }
}
