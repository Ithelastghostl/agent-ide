import { describe, it, expect } from 'vitest'
import { homedir } from 'node:os'
import { PtyManager, resolveCwd, classifyExit } from '../../src/main/ptyManager'

describe('classifyExit', () => {
  it('user kill -> closed, otherwise crashed', () => {
    expect(classifyExit(true)).toBe('closed')
    expect(classifyExit(false)).toBe('crashed')
  })
})

describe('resolveCwd', () => {
  it('keeps an existing directory', () => {
    expect(resolveCwd(process.cwd())).toBe(process.cwd())
  })
  it('falls back to home for a missing path', () => {
    expect(resolveCwd('/no/such/path/here/xyz')).toBe(homedir())
  })
  it('falls back to home for empty cwd', () => {
    expect(resolveCwd('')).toBe(homedir())
  })
})

describe('PtyManager', () => {
  it('spawns a process, emits data, and kills it', async () => {
    const mgr = new PtyManager()
    const chunks: string[] = []
    mgr.spawn(
      { id: 's1', shell: 'bash', args: ['-c', 'echo hello-pty'], cwd: process.cwd(), env: {} },
      (d) => chunks.push(d)
    )
    await new Promise((r) => setTimeout(r, 600))
    expect(chunks.join('')).toContain('hello-pty')
    mgr.kill('s1')
    expect(mgr.has('s1')).toBe(false)
  })

  it('writes input to a running shell and sees it echoed', async () => {
    const mgr = new PtyManager()
    const chunks: string[] = []
    mgr.spawn(
      { id: 's2', shell: 'bash', args: [], cwd: process.cwd(), env: {} },
      (d) => chunks.push(d)
    )
    await new Promise((r) => setTimeout(r, 300))
    mgr.write('s2', 'echo written-in\n')
    await new Promise((r) => setTimeout(r, 500))
    expect(chunks.join('')).toContain('written-in')
    mgr.kill('s2')
  })

  it('removes a process from tracking when it exits on its own', async () => {
    const mgr = new PtyManager()
    mgr.spawn(
      { id: 's3', shell: 'bash', args: ['-c', 'true'], cwd: process.cwd(), env: {} },
      () => {}
    )
    await new Promise((r) => setTimeout(r, 600))
    expect(mgr.has('s3')).toBe(false)
  })

  it('reports reason=closed when kill() ends the process', async () => {
    const mgr = new PtyManager()
    let reason = ''
    mgr.spawn(
      { id: 's4', shell: 'bash', args: [], cwd: process.cwd(), env: {} },
      () => {},
      (info) => { reason = info.reason }
    )
    await new Promise((r) => setTimeout(r, 250))
    mgr.kill('s4')
    await new Promise((r) => setTimeout(r, 400))
    expect(reason).toBe('closed')
  })

  it('replacing an existing id kills the old proc and keeps only the new (Codex P2)', async () => {
    const mgr = new PtyManager()
    const out: string[] = []
    mgr.spawn({ id: 'dup', shell: 'bash', args: [], cwd: process.cwd(), env: {} }, () => {})
    await new Promise((r) => setTimeout(r, 200))
    // replace same id with a process that prints a marker
    mgr.spawn({ id: 'dup', shell: 'bash', args: ['-c', 'echo NEWPROC; sleep 1'], cwd: process.cwd(), env: {} }, (d) => out.push(d))
    await new Promise((r) => setTimeout(r, 500))
    // the new proc is the tracked one and is alive
    expect(mgr.has('dup')).toBe(true)
    expect(out.join('')).toContain('NEWPROC')
    mgr.kill('dup')
  })

  it('reports reason=crashed when the process dies on its own', async () => {
    const mgr = new PtyManager()
    let reason = ''
    mgr.spawn(
      { id: 's5', shell: 'bash', args: ['-c', 'exit 1'], cwd: process.cwd(), env: {} },
      () => {},
      (info) => { reason = info.reason }
    )
    await new Promise((r) => setTimeout(r, 500))
    expect(reason).toBe('crashed')
  })

  // B3 (High): a replaced (old) proc's async onExit could fire the caller's
  // onExit for the *new* same-id session — archiving/idling a live session. Fix:
  // per-session generation token; the old proc's exit is ignored because its
  // generation is no longer current.
  it('does NOT fire onExit for a replaced old proc (B3 generation race)', async () => {
    const mgr = new PtyManager()
    const exits: string[] = []
    // gen 1: a long-lived proc we will replace before it exits
    mgr.spawn(
      { id: 'race', shell: 'bash', args: ['-c', 'sleep 2'], cwd: process.cwd(), env: {} },
      () => {},
      (info) => exits.push(`gen1:${info.reason}`)
    )
    await new Promise((r) => setTimeout(r, 200))
    // gen 2: replace same id with a fresh long-lived proc. This kills gen1, whose
    // onExit will fire asynchronously shortly after.
    mgr.spawn(
      { id: 'race', shell: 'bash', args: ['-c', 'sleep 2'], cwd: process.cwd(), env: {} },
      () => {},
      (info) => exits.push(`gen2:${info.reason}`)
    )
    // wait long enough for gen1's kill-driven exit to land
    await new Promise((r) => setTimeout(r, 500))
    // the live (gen2) session must be untouched: no stale exit callback fired
    expect(exits).toEqual([])
    expect(mgr.has('race')).toBe(true)

    // and when we DO kill gen2, exactly its own callback fires — once
    mgr.kill('race')
    await new Promise((r) => setTimeout(r, 400))
    expect(exits).toEqual(['gen2:closed'])
  })
})
