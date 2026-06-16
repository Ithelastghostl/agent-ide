import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Clicking a URL in a terminal must open it in the host browser — for BOTH a
// plain-text URL and an OSC-8 hyperlink (the form agent CLIs actually emit).
// The OSC-8 case is the regression that shipped broken: xterm's built-in
// OscLinkProvider claimed the click and ran confirm()+window.open() (the "are
// you sure?" dialog), which the main window then denied — so nothing opened.
// The fix routes OSC-8 links through Terminal({ linkHandler }) → openExternal.

// contextBridge freezes window.agentIDE, so we can't stub openExternal in the
// page. Instead the main process records opened URLs to a file (AGENT_IDE_OPEN_LOG)
// AND still opens — observing the real click → activate → IPC path end to end.

async function openProjectWithTerminal(): Promise<{ app: ElectronApplication; win: Page; openLog: string }> {
  const proj = mkdtempSync(join(tmpdir(), 'agide-proj-'))
  mkdirSync(join(proj, 'src')); writeFileSync(join(proj, 'README.md'), '# x\n')
  const dbPath = join(mkdtempSync(join(tmpdir(), 'agide-db-')), 'store.sqlite')
  const openLog = join(mkdtempSync(join(tmpdir(), 'agide-open-')), 'opened.log')
  const app = await electron.launch({
    args: [join(__dirname, '..'), '--no-sandbox'],
    env: { ...process.env, AGENT_IDE_DB: dbPath, AGENT_IDE_OPEN_LOG: openLog }
  })
  const win = await app.firstWindow()
  await win.waitForSelector('.projrail', { timeout: 15_000 })
  await win.evaluate(async (p) => { await window.agentIDE.projectsAddLocal(p) }, proj)
  await expect.poll(async () => (await win.evaluate(() => window.agentIDE.projectsList())).length, { timeout: 10_000 }).toBeGreaterThan(0)
  await win.reload()
  await win.waitForSelector('.projrail .pj', { timeout: 15_000 })
  await win.locator('.projrail .pj').first().click()
  await win.locator('.provrow.terminal .add').click()
  await win.waitForSelector('.terminal-host .xterm', { timeout: 10_000 })
  return { app, win, openLog }
}

/** Wait for `visibleText` to render on a row, then click its middle with a real
 *  mouse sequence (hover-in, press, release) so xterm's hit-testing fires. */
async function clickTextInTerminal(win: Page, visibleText: string) {
  await expect.poll(async () => win.evaluate((needle) => {
    const rows = Array.from(document.querySelectorAll('.terminal-host .xterm-rows > div')) as HTMLElement[]
    return rows.some((r) => (r.textContent || '').includes(needle))
  }, visibleText), { timeout: 8_000 }).toBe(true)

  const target = await win.evaluate((needle) => {
    const rowsEl = document.querySelector('.terminal-host .xterm-rows') as HTMLElement
    const cellW = rowsEl.getBoundingClientRect().width / 80
    const rows = Array.from(rowsEl.children) as HTMLElement[]
    for (const r of rows) {
      const t = r.textContent || ''
      const i = t.indexOf(needle)
      if (i >= 0) {
        const rc = r.getBoundingClientRect()
        return { x: rc.left + cellW * (i + needle.length / 2), y: rc.top + rc.height / 2 }
      }
    }
    return null
  }, visibleText)
  expect(target).not.toBeNull()

  await win.mouse.move(target!.x - 120, target!.y - 30)
  await win.mouse.move(target!.x, target!.y)
  await win.waitForTimeout(300)
  await win.mouse.down()
  await win.mouse.up()
}

async function writeToTerminal(win: Page, data: string) {
  await win.evaluate(async (d) => {
    const sessions = await window.agentIDE.sessionsAll()
    const term = sessions.filter((s: any) => s.id.startsWith('term-')).pop()
    if (term) window.agentIDE.ptyWrite(term.id, d)
  }, data)
}

test('clicking a PLAIN-TEXT terminal URL opens it in the host browser', async () => {
  const { app, win, openLog } = await openProjectWithTerminal()
  await writeToTerminal(win, 'echo SEE https://example.com/plain\n')
  await clickTextInTerminal(win, 'https://example.com/plain')
  await expect.poll(() => (existsSync(openLog) ? readFileSync(openLog, 'utf8') : ''), { timeout: 5_000 })
    .toContain('https://example.com/plain')
  await app.close()
})

test('clicking an OSC-8 hyperlink opens it in the host browser (regression)', async () => {
  const { app, win, openLog } = await openProjectWithTerminal()
  // OSC-8 hyperlink: ESC ]8;;URL ESC \  TEXT  ESC ]8;; ESC \  — printf interprets \e and \a.
  // Use BEL (\a) terminators for robustness. Visible text is "OPEN-DOCS".
  await writeToTerminal(win, `printf 'go \\033]8;;https://example.com/osc8\\aOPEN-DOCS\\033]8;;\\a\\n'\n`)
  await clickTextInTerminal(win, 'OPEN-DOCS')
  await expect.poll(() => (existsSync(openLog) ? readFileSync(openLog, 'utf8') : ''), { timeout: 5_000 })
    .toContain('https://example.com/osc8')
  await app.close()
})
