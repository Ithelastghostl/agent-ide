// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import type { TerminalHost } from '../../src/renderer/components/SessionTerminal'

// main.ts self-boots on import (registers IPC listeners, calls boot()), so it
// cannot be imported here. These tests pin the FOCUS CONTRACT that main.ts's
// focusedTerminalId()/restoreFocus() implement against the same element shape
// SessionTerminal returns, plus the DOM behaviour that caused the bug:
// re-attaching a detached node does NOT restore its focus.

const terminals = new Map<string, TerminalHost>()

/** A stand-in for SessionTerminal's element: a focusable node exposing the same
 *  __focus/__hasFocus hooks the real one sets after term.open(). */
function fakeTerminal(): TerminalHost {
  const host = document.createElement('div') as TerminalHost
  const input = document.createElement('textarea') // xterm's real focus target
  host.appendChild(input)
  host.__focus = () => input.focus()
  host.__hasFocus = () => host.contains(document.activeElement)
  return host
}

// --- the logic under test, mirroring src/renderer/main.ts ---
function focusedTerminalId(): string | undefined {
  for (const [id, el] of terminals) if (el.__hasFocus?.()) return id
  return undefined
}
function restoreFocus(id: string | undefined): void {
  if (!id) return
  if (document.querySelector('.modal-wrap.show')) return
  const el = terminals.get(id)
  if (!el?.isConnected) return
  if (el.__hasFocus?.()) return
  el.__focus?.()
}

let root: HTMLElement
beforeEach(() => {
  document.body.innerHTML = ''
  terminals.clear()
  root = document.createElement('div')
  document.body.appendChild(root)
})

/** One render cycle: tear the tree down and rebuild it, as render() does. */
function rerender(mounted: TerminalHost[]): void {
  const refocus = focusedTerminalId()
  root.innerHTML = ''
  for (const el of mounted) root.appendChild(el)
  restoreFocus(refocus)
}

describe('terminal focus survives a re-render', () => {
  it('reproduces the bug: re-attaching alone loses focus', () => {
    const term = fakeTerminal()
    terminals.set('s1', term)
    root.appendChild(term)
    term.__focus!()
    expect(term.__hasFocus!()).toBe(true)

    // What render() does with no restore step.
    root.innerHTML = ''
    root.appendChild(term)

    expect(term.__hasFocus!()).toBe(false)
    expect(document.activeElement).toBe(document.body)
  })

  it('keeps focus in the terminal across a re-render', () => {
    const term = fakeTerminal()
    terminals.set('s1', term)
    root.appendChild(term)
    term.__focus!()

    rerender([term])

    expect(term.__hasFocus!()).toBe(true)
  })

  it('survives repeated re-renders (idle/attention/cost events)', () => {
    const term = fakeTerminal()
    terminals.set('s1', term)
    root.appendChild(term)
    term.__focus!()

    for (let i = 0; i < 5; i++) rerender([term])

    expect(term.__hasFocus!()).toBe(true)
  })

  it('restores the focused terminal only, not every terminal', () => {
    const a = fakeTerminal()
    const b = fakeTerminal()
    terminals.set('a', a)
    terminals.set('b', b)
    root.append(a, b)
    b.__focus!()

    rerender([a, b])

    expect(b.__hasFocus!()).toBe(true)
    expect(a.__hasFocus!()).toBe(false)
  })

  it('does NOT steal focus when the user is typing elsewhere', () => {
    const term = fakeTerminal()
    terminals.set('s1', term)
    root.appendChild(term)
    const other = document.createElement('input')
    document.body.appendChild(other)
    other.focus()

    rerender([term])

    expect(document.activeElement).toBe(other)
    expect(term.__hasFocus!()).toBe(false)
  })

  it('does NOT steal focus from an open modal', () => {
    const term = fakeTerminal()
    terminals.set('s1', term)
    root.appendChild(term)
    term.__focus!()

    // A modal opens during this render and takes the caret on purpose.
    const refocus = focusedTerminalId()
    root.innerHTML = ''
    root.appendChild(term)
    const modal = document.createElement('div')
    modal.className = 'modal-wrap show'
    const field = document.createElement('input')
    modal.appendChild(field)
    document.body.appendChild(modal)
    field.focus()
    restoreFocus(refocus)

    expect(document.activeElement).toBe(field)
  })

  it('does nothing when the terminal was unmounted during the render', () => {
    const term = fakeTerminal()
    terminals.set('s1', term)
    root.appendChild(term)
    term.__focus!()

    // Session closed: it is not re-attached this cycle.
    expect(() => rerender([])).not.toThrow()
    expect(term.isConnected).toBe(false)
  })

  it('no-ops when no terminal held focus', () => {
    const term = fakeTerminal()
    terminals.set('s1', term)
    root.appendChild(term)

    rerender([term])

    expect(document.activeElement).toBe(document.body)
  })
})
