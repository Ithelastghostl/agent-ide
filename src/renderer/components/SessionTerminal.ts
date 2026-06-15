import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { showMenu } from '../ui'

export interface TerminalSpawn {
  shell: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

/** An xterm terminal bound to a pty session in the main process. Mounts on next
 *  microtask, then wires I/O. If `spawn` is provided, it spawns the pty
 *  (used for plain bash/mock sessions); if omitted, it only ATTACHES to a pty
 *  the main process already started (real provider sessions via session:launch). */
export function SessionTerminal(sessionId: string, spawn?: TerminalSpawn): HTMLElement {
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

  async function copySelection(): Promise<boolean> {
    const sel = term.getSelection()
    if (!sel) return false
    try { await navigator.clipboard.writeText(sel) } catch { /* clipboard blocked */ }
    return true
  }
  async function paste(): Promise<void> {
    try {
      const text = await navigator.clipboard.readText()
      if (text) window.agentIDE.ptyWrite(sessionId, text)
    } catch { /* clipboard blocked */ }
  }

  // F5: Ctrl+Shift+C copies the selection (only if there is one — otherwise let
  // the terminal receive Ctrl+C), Ctrl+Shift+V pastes.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true
    if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
      if (term.hasSelection()) { void copySelection(); return false }
      return true
    }
    if (e.ctrlKey && e.shiftKey && (e.key === 'V' || e.key === 'v')) {
      void paste(); return false
    }
    return true
  })

  queueMicrotask(() => {
    term.open(host)
    try { fit.fit() } catch { /* host not laid out yet */ }

    // Only spawn when given a spec; otherwise attach to an already-running pty.
    if (spawn) {
      window.agentIDE.ptySpawn({ id: sessionId, shell: spawn.shell, args: spawn.args, cwd: spawn.cwd, env: spawn.env })
    }

    term.onData((d) => window.agentIDE.ptyWrite(sessionId, d))
    window.agentIDE.onPtyData((p) => { if (p.id === sessionId) term.write(p.data) })
    term.onResize(({ cols, rows }) => window.agentIDE.ptyResize(sessionId, cols, rows))

    // F5: right-click context menu with Copy / Paste (reuses shared showMenu)
    host.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      showMenu(e.clientX, e.clientY, [
        { label: 'Copy', disabled: !term.hasSelection(), onClick: () => void copySelection() },
        { label: 'Paste', onClick: () => void paste() }
      ])
    })

    // refit on container resize
    const ro = new ResizeObserver(() => { try { fit.fit() } catch { /* ignore */ } })
    ro.observe(host)
  })

  return host
}
