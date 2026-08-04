import { describe, it, expect } from 'vitest'
import { launchErrorMessage, decideRunContext } from '../../src/renderer/runContext'

describe('decideRunContext — Connect must reach the launch', () => {
  const withDc = { hasDevcontainer: true }
  const noDc = { hasDevcontainer: false }

  it('THE BUG: an explicit Connect beats a stale hasDevcontainer=false', () => {
    // Previously hasDevcontainer was checked first, so a Connected project whose
    // cached column had not caught up launched silently on the host.
    expect(decideRunContext(noDc, true)).toEqual({ useContainer: true, importConfig: false })
  })

  it('honours Connect on a project with a devcontainer', () => {
    expect(decideRunContext(withDc, true)).toEqual({ useContainer: true, importConfig: false })
  })

  it('honours Disconnect even when a devcontainer exists', () => {
    expect(decideRunContext(withDc, false)).toEqual({ useContainer: false, importConfig: false })
  })

  it('falls back to host when there is no devcontainer and no choice', () => {
    expect(decideRunContext(noDc, undefined)).toEqual({ useContainer: false, importConfig: false })
  })

  it('asks when a devcontainer exists but the user has not chosen', () => {
    expect(decideRunContext(withDc, undefined)).toBe('ask')
  })

  it('never infers a container launch from an absent choice', () => {
    // Safety: undefined must never yield useContainer true without a prompt.
    for (const proj of [withDc, noDc]) {
      const r = decideRunContext(proj, undefined)
      if (r !== 'ask') expect(r.useContainer).toBe(false)
    }
  })
})

describe('launchErrorMessage — a failed launch must not look like a no-op', () => {
  it('names the missing devcontainer CLI and the command that fixes it', () => {
    const msg = launchErrorMessage(
      new Error('devcontainer CLI not found. Install it: npm i -g @devcontainers/cli')
    )
    expect(msg).toContain('devcontainer CLI')
    expect(msg).toContain('npm i -g @devcontainers/cli')
  })

  it('unwraps the Electron IPC error prefix', () => {
    const wrapped = new Error(
      "Error invoking remote method 'session:launch': Error: devcontainer CLI not found. Install it: npm i -g @devcontainers/cli"
    )
    expect(launchErrorMessage(wrapped)).toContain('npm i -g @devcontainers/cli')
  })

  it('reports other failures with their real message', () => {
    const wrapped = new Error("Error invoking remote method 'session:launch': Error: boom")
    expect(launchErrorMessage(wrapped)).toBe('Launch failed: boom')
  })

  it('handles a non-Error throw', () => {
    expect(launchErrorMessage('plain string')).toBe('Launch failed: plain string')
  })

  it('never returns an empty message', () => {
    for (const input of [new Error(''), '', null, undefined]) {
      expect(launchErrorMessage(input).length).toBeGreaterThan(0)
    }
  })
})
