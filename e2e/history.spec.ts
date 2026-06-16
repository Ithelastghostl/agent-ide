import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// The IDE owns each session's history: every session writes its OWN file under
// ~/AgentIDE/history/<id>.log, and two sessions never share one. Regression guard
// for the bug where independent same-provider sessions bled into one conversation.
test('each session gets its own history file (no shared history)', async () => {
  const proj = mkdtempSync(join(tmpdir(), 'agide-proj-'))
  mkdirSync(join(proj, 'src')); writeFileSync(join(proj, 'README.md'), '# x\n')
  const dbPath = join(mkdtempSync(join(tmpdir(), 'agide-db-')), 'store.sqlite')
  const histDir = mkdtempSync(join(tmpdir(), 'agide-hist-'))
  const app = await electron.launch({ args: [join(__dirname, '..'), '--no-sandbox'], env: { ...process.env, AGENT_IDE_DB: dbPath, AGENT_IDE_HISTORY: histDir } })
  const win = await app.firstWindow()
  await win.waitForSelector('.projrail', { timeout: 15_000 })
  await win.evaluate(async (p) => { await window.agentIDE.projectsAddLocal(p) }, proj)
  await expect.poll(async () => (await win.evaluate(() => window.agentIDE.projectsList())).length, { timeout: 10_000 }).toBeGreaterThan(0)
  await win.reload()
  await win.waitForSelector('.projrail .pj', { timeout: 15_000 })
  await win.locator('.projrail .pj').first().click()

  // Open two plain terminal sessions and write DISTINCT text into each.
  await win.locator('.provrow.terminal .add').click()
  await win.waitForSelector('.terminal-host .xterm', { timeout: 10_000 })
  await win.waitForTimeout(500)
  await win.locator('.provrow.terminal .add').click()
  await win.waitForTimeout(800)

  const ids = await win.evaluate(async () => {
    const sessions = (await window.agentIDE.sessionsAll()).filter((s: any) => s.id.startsWith('term-'))
    const a = sessions[sessions.length - 2], b = sessions[sessions.length - 1]
    window.agentIDE.ptyWrite(a.id, 'echo AAA_SESSION_ONE\n')
    window.agentIDE.ptyWrite(b.id, 'echo BBB_SESSION_TWO\n')
    return { a: a.id, b: b.id }
  })
  await win.waitForTimeout(1500)

  const fileA = join(histDir, `${ids.a}.log`)
  const fileB = join(histDir, `${ids.b}.log`)
  expect(existsSync(fileA)).toBe(true)
  expect(existsSync(fileB)).toBe(true)
  // Each file holds ONLY its own session's output — no cross-contamination.
  const a = readFileSync(fileA, 'utf8'), b = readFileSync(fileB, 'utf8')
  expect(a).toContain('AAA_SESSION_ONE')
  expect(a).not.toContain('BBB_SESSION_TWO')
  expect(b).toContain('BBB_SESSION_TWO')
  expect(b).not.toContain('AAA_SESSION_ONE')

  await app.close()
})
