import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

export interface TerminalSpawn {
  shell: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

/** An xterm terminal bound to a pty session in the main process. Mounts on next
 *  microtask (so it can attach to the live DOM), then spawns + wires I/O. */
export function SessionTerminal(sessionId: string, spawn: TerminalSpawn): HTMLElement {
  const host = document.createElement('div')
  host.className = 'terminal-host'

  const term = new Terminal({
    fontSize: 12,
    fontFamily: 'Menlo, Consolas, monospace',
    cursorBlink: true,
    theme: {
      background: '#07080a',
      foreground: '#f0f5f4',
      cursor: '#533afd',
      cursorAccent: '#07080a',
      selectionBackground: 'rgba(83,58,253,0.3)'
    }
  })
  const fit = new FitAddon()
  term.loadAddon(fit)

  queueMicrotask(() => {
    term.open(host)
    try { fit.fit() } catch { /* host not laid out yet */ }

    window.agentIDE.ptySpawn({ id: sessionId, shell: spawn.shell, args: spawn.args, cwd: spawn.cwd, env: spawn.env })

    term.onData((d) => window.agentIDE.ptyWrite(sessionId, d))
    window.agentIDE.onPtyData((p) => { if (p.id === sessionId) term.write(p.data) })
    term.onResize(({ cols, rows }) => window.agentIDE.ptyResize(sessionId, cols, rows))

    // refit on container resize
    const ro = new ResizeObserver(() => { try { fit.fit() } catch { /* ignore */ } })
    ro.observe(host)
  })

  return host
}
