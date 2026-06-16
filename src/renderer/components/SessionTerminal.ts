import { Terminal, type ILink } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { showMenu, type MenuItem } from '../ui'

// Matches http(s) URLs in terminal output. Used BOTH to linkify clickable URLs
// and to find a URL under the pointer for the right-click menu.
// NOTE: we register our own link provider instead of @xterm/addon-web-links —
// that addon (0.12, xterm-5 era) silently fails against @xterm/xterm@6 and
// creates no links at all, so clicks never fired. registerLinkProvider is the
// stable xterm-6 API the addon merely wraps.
const URL_RE = /https?:\/\/[^\s"'`<>()]+/g

/** An xterm terminal that ATTACHES to a pty the main process already started
 *  (via session:launch / terminal:open / session:resume). The renderer never
 *  spawns raw shells. The returned element carries a `dispose()` (on
 *  `el.__dispose`) that unsubscribes the pty:data listener and disposes the
 *  terminal — call it when the element is dropped (avoids listener leaks). */
export function SessionTerminal(sessionId: string): HTMLElement & { __dispose?: () => void } {
  const host = document.createElement('div') as HTMLElement & { __dispose?: () => void }
  host.className = 'terminal-host'

  // Open a URL in the host browser via main. Pass sessionId so main can forward
  // a container localhost port out to the host first (OAuth callbacks, dev servers).
  const open = (uri: string) => { void window.agentIDE.openExternal(uri, sessionId) }

  const term = new Terminal({
    fontSize: 12,
    fontFamily: 'Menlo, Consolas, monospace',
    cursorBlink: true,
    allowProposedApi: true,
    // OSC-8 hyperlinks (the clickable links agent CLIs actually emit) are handled
    // by xterm's BUILT-IN OscLinkProvider, which registers before any provider we
    // add and therefore wins the click. Its default action is confirm()+window.open()
    // — that's the "are you sure?" dialog, and window.open is then denied by the
    // main window's setWindowOpenHandler, so nothing opened. Setting linkHandler
    // overrides that default so OSC-8 links route through our host-browser IPC too.
    linkHandler: {
      activate: (e, uri) => { e.preventDefault(); open(uri) },
      allowNonHttpProtocols: false
    },
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

  // Clickable PLAIN-TEXT URLs (no OSC-8 escape): scan each row for http(s) URLs
  // and hand xterm a link range per match. Left-click → host browser. (OSC-8
  // hyperlinks are handled by linkHandler above.)
  term.registerLinkProvider({
    provideLinks(lineNumber, callback) {
      const line = term.buffer.active.getLine(lineNumber - 1)
      if (!line) { callback(undefined); return }
      const text = line.translateToString(true)
      const links: ILink[] = []
      for (const m of text.matchAll(URL_RE)) {
        const start = m.index ?? 0
        const uri = m[0]
        links.push({
          // xterm columns are 1-based; range end is inclusive.
          range: { start: { x: start + 1, y: lineNumber }, end: { x: start + uri.length, y: lineNumber } },
          text: uri,
          activate: (e) => { e.preventDefault(); open(uri) }
        })
      }
      callback(links.length ? links : undefined)
    }
  })

  async function copyText(text: string): Promise<boolean> {
    if (!text) return false
    try { await navigator.clipboard.writeText(text) } catch { /* clipboard blocked */ }
    return true
  }
  async function copySelection(): Promise<boolean> {
    return copyText(term.getSelection())
  }

  // Find an http(s) URL at a pixel position within the terminal, for click-to-open
  // and the right-click Copy/Open menu. Uses PUBLIC geometry (the .xterm-rows
  // element + term.cols/rows) rather than xterm private internals, which proved
  // unavailable on xterm 6.
  function linkAtEvent(e: MouseEvent): string | undefined {
    const rowsEl = host.querySelector('.xterm-rows') as HTMLElement | null
    if (!rowsEl) return undefined
    const rect = rowsEl.getBoundingClientRect()
    if (!rect.width || !rect.height) return undefined
    const cellW = rect.width / term.cols
    const cellH = rect.height / term.rows
    const col = Math.floor((e.clientX - rect.left) / cellW)
    const row = Math.floor((e.clientY - rect.top) / cellH)
    if (col < 0 || row < 0) return undefined
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
            { label: 'Open Link', onClick: () => open(link) },
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
