import { test, expect, _electron as electron } from '@playwright/test'
import { electronArgs } from './launch'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// A4 (macOS lifecycle): closing the window must NOT kill sessions or break IPC.
// Dock activation recreates a window that ATTACHES to the surviving pty — the
// reopened renderer must see the pty as alive (no killing "reconnect"), and
// main must not re-register its process-global handlers.
test('sessions survive window close; a recreated window reattaches to the live pty', async () => {
  const proj = mkdtempSync(join(tmpdir(), 'agide-lc-proj-'))
  mkdirSync(join(proj, 'src')); writeFileSync(join(proj, 'README.md'), '# x\n')
  const dbPath = join(mkdtempSync(join(tmpdir(), 'agide-lc-db-')), 'store.sqlite')
  const histDir = mkdtempSync(join(tmpdir(), 'agide-lc-hist-'))

  const app = await electron.launch({
    args: electronArgs(),
    env: { ...process.env, AGENT_IDE_DB: dbPath, AGENT_IDE_HISTORY: histDir }
  })
  const win1 = await app.firstWindow()
  await win1.waitForSelector('.projrail', { timeout: 20_000 })
  await win1.evaluate(async (p) => { await window.agentIDE.projectsAddLocal(p) }, proj)

  // Open a plain terminal session (live pty owned by main, not the window).
  const sessionId = await win1.evaluate(async (cwd) => {
    const projects = await window.agentIDE.projectsList()
    const s = await window.agentIDE.terminalOpen({ projectId: projects[0].id, cwd, name: 'lifecycle', useContainer: false })
    return s.id
  }, proj)
  expect(await win1.evaluate((id) => window.agentIDE.ptyAlive(id), sessionId)).toBe(true)

  // Close the window. On macOS the app (and the pty) keeps running.
  await app.evaluate(async ({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.close()
  })
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0)

  // The pty survives with no window: write into it straight from main's side
  // via a new window below — first recreate one (Dock activation path).
  await app.evaluate(({ app: electronApp }) => { electronApp.emit('activate') })
  const win2 = await app.waitForEvent('window', { timeout: 15_000 })
  await win2.waitForSelector('.projrail', { timeout: 20_000 })

  // No duplicate-handler breakage: IPC still answers.
  expect(await win2.evaluate(() => window.agentIDE.ping())).toBe('pong')

  // The reopened renderer sees the pty as ALIVE (attach, not reconnect)…
  expect(await win2.evaluate((id) => window.agentIDE.ptyAlive(id), sessionId)).toBe(true)
  const status = await win2.evaluate(async (id) => (await window.agentIDE.sessionsAll()).find((s: any) => s.id === id)?.status, sessionId)
  expect(status).toBe('running')

  // …and it is the SAME live shell: writing to it produces fresh output that
  // reaches the session's history file (main-side recordOutput still wired).
  await win2.evaluate((id) => window.agentIDE.ptyWrite(id, 'echo LIFECYCLE_ALIVE_$((40+2))\r'), sessionId)
  const file = join(histDir, `${sessionId}.log`)
  await expect.poll(() => (existsSync(file) ? readFileSync(file, 'utf8') : ''), { timeout: 8_000 })
    .toContain('LIFECYCLE_ALIVE_42')

  await app.close()
})
