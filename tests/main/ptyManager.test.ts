import { describe, it, expect } from 'vitest'
import { homedir } from 'node:os'
import { PtyManager, resolveCwd } from '../../src/main/ptyManager'

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
})
