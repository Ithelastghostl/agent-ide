import { describe, it, expect, vi } from 'vitest'
import { createQuitCoordinator } from '../../src/main/ipc'
import { hostShell } from '../../src/main/ptyManager'

// A5: shutdown must AWAIT relay/watcher teardown (bounded) before exiting —
// a fire-and-forget stop() let Electron exit first and leak host relays.
describe('createQuitCoordinator (A5)', () => {
  const event = () => ({
    prevented: false,
    preventDefault() {
      this.prevented = true
    }
  })

  it('intercepts the first quit, awaits cleanup, then exits', async () => {
    let cleaned = false
    let exited = false
    const handler = createQuitCoordinator(
      async () => {
        cleaned = true
      },
      () => {
        exited = true
      },
      1000
    )
    const e = event()
    handler(e)
    expect(e.prevented).toBe(true)
    await vi.waitFor(() => expect(exited).toBe(true))
    expect(cleaned).toBe(true)
  })

  it('exits even when cleanup rejects', async () => {
    let exited = false
    const handler = createQuitCoordinator(
      async () => {
        throw new Error('relay stuck')
      },
      () => {
        exited = true
      },
      1000
    )
    handler(event())
    await vi.waitFor(() => expect(exited).toBe(true))
  })

  it('exits after the timeout when cleanup hangs', async () => {
    let exited = false
    const handler = createQuitCoordinator(
      () =>
        new Promise(() => {
          /* never */
        }),
      () => {
        exited = true
      },
      20
    )
    handler(event())
    await vi.waitFor(() => expect(exited).toBe(true))
  })

  it('a second quit event passes through (no double preventDefault loop)', () => {
    const handler = createQuitCoordinator(
      async () => {},
      () => {},
      1000
    )
    const first = event()
    const second = event()
    handler(first)
    handler(second)
    expect(first.prevented).toBe(true)
    expect(second.prevented).toBe(false)
  })
})

// A3: host terminals use the USER's shell (macOS ships bash 3.2, defaults zsh).
describe('hostShell (A3)', () => {
  it('prefers $SHELL', () => {
    expect(hostShell({ SHELL: '/bin/zsh' })).toBe('/bin/zsh')
    expect(hostShell({ SHELL: '/opt/homebrew/bin/fish' })).toBe('/opt/homebrew/bin/fish')
  })
  it('falls back to the passwd shell, then a platform default, when SHELL is unset/empty', () => {
    const got = hostShell({})
    expect(got).toBeTruthy()
    // Whatever the source, the result must be a shell, never the empty string.
    expect(got.length).toBeGreaterThan(0)
    expect(hostShell({ SHELL: '' })).toBe(got)
  })
})
