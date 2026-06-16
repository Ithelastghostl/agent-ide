import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { showMenu, type MenuItem } from '../ui'

// Matches http(s) URLs in terminal output for the right-click "Copy link" menu.
// The WebLinksAddon does its own (stricter) detection for clicks; this is only
// used to find a URL under the pointer when building the context menu.
const URL_RE = /https?:\/\/[^\s"'`<>()]+/g

/** An xterm terminal that ATTACHES to a pty the main process already started
 *  (via session:launch / terminal:open / session:resume). The renderer never
 *  spawns raw shells. The returned element carries a `dispose()` (on
 *  `el.__dispose`) that unsubscribes the pty:data listener and disposes the
 *  terminal — call it when the element is dropped (avoids listener leaks). */
export function SessionTerminal(sessionId: string): HTMLElement & { __dispose?: () => void } {
  const host = document.createElement('div') as HTMLElement & { __dispose?: () => void }
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

  // Clickable URLs in terminal output. Plain left-click opens in the host's
  // default browser via main (works from inside containers). We deliberately
  // route through openExternal rather than letting the addon window.open, which
  // would spawn a new Electron window.
  term.loadAddon(
    new WebLinksAddon((event, uri) => {
      event.preventDefault()
      void window.agentIDE.openExternal(uri)
    })
  )

  async function copyText(text: string): Promise<boolean> {
    if (!text) return false
    try { await navigator.clipboard.writeText(text) } catch { /* clipboard blocked */ }
    return true
  }
  async function copySelection(): Promise<boolean> {
    return copyText(term.getSelection())
  }

  // Find an http(s) URL at a pixel position within the terminal, so the
  // right-click menu can offer Copy/Open for the link directly under the cursor
  // (xterm selects nothing on right-click, so plain "Copy" misses links).
  function linkAtEvent(e: MouseEvent): string | undefined {
    const rect = host.getBoundingClientRect()
    const dims = (term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } } })._core
    const cell = dims?._renderService?.dimensions?.css?.cell
    if (!cell || !cell.width || !cell.height) return undefined
    const col = Math.floor((e.clientX - rect.left) / cell.width)
    const row = Math.floor((e.clientY - rect.top) / cell.height)
    const buffer = term.buffer.active
    const line = buffer.getLine(buffer.viewportY + row)
    if (!line) return undefined
    const text = line.translateToString(true)
    for (const m of text.matchAll(URL_RE)) {
      const start = m.index ?? 0
      if (col >= start && col < start + m[0].length) return m[0]
    }
    return undefined
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

    term.onData((d) => window.agentIDE.ptyWrite(sessionId, d))

    // Replay saved transcript (chat history) BEFORE showing live output, so a
    // reopened/reconnected session isn't blank. Live chunks that arrive during
    // the async fetch are buffered, then flushed in order after the replay — so
    // history and live output never interleave (Codex P2: no torn escape seqs).
    let replayed = false
    const pending: string[] = []
    const unsubscribe = window.agentIDE.onPtyData((p) => {
      if (p.id !== sessionId) return
      if (replayed) term.write(p.data)
      else pending.push(p.data)
    })
    window.agentIDE
      .transcriptGet(sessionId)
      .then((history) => { if (history) term.write(history) })
      .catch(() => { /* no history / store unavailable — show live only */ })
      .finally(() => {
        replayed = true
        for (const chunk of pending) term.write(chunk)
        pending.length = 0
      })

    term.onResize(({ cols, rows }) => window.agentIDE.ptyResize(sessionId, cols, rows))

    // F5: right-click context menu with Copy / Paste (reuses shared showMenu).
    // When the cursor is over a URL, also offer Open / Copy link address.
    host.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      const link = linkAtEvent(e)
      const items: MenuItem[] = link
        ? [
            { label: 'Open Link', onClick: () => void window.agentIDE.openExternal(link) },
            { label: 'Copy Link Address', onClick: () => void copyText(link) }
          ]
        : []
      items.push(
        { label: 'Copy', disabled: !term.hasSelection(), onClick: () => void copySelection() },
        { label: 'Paste', onClick: () => void paste() }
      )
      showMenu(e.clientX, e.clientY, items)
    })

    // refit on container resize
    const ro = new ResizeObserver(() => { try { fit.fit() } catch { /* ignore */ } })
    ro.observe(host)

    host.__dispose = () => {
      unsubscribe()
      ro.disconnect()
      term.dispose()
    }
  })

  return host
}
