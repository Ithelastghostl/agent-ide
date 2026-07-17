import { test, expect, _electron as electron } from '@playwright/test'
import { electronArgs } from './launch'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Pasting a multi-line string must arrive as ONE bracketed paste, not as
// line-by-line typed input. Regression guard for the garbling bug where raw
// ptyWrite bypassed xterm's bracketed-paste wrapping, so programs that enable
// bracketed paste (the agent CLIs) interleaved the paste with their own redraws.
test('paste arrives wrapped in bracketed-paste markers (not garbled)', async () => {
  const proj = mkdtempSync(join(tmpdir(), 'agide-proj-'))
  mkdirSync(join(proj, 'src'))
  writeFileSync(join(proj, 'README.md'), '# x\n')
  const dbPath = join(mkdtempSync(join(tmpdir(), 'agide-db-')), 'store.sqlite')
  const histDir = mkdtempSync(join(tmpdir(), 'agide-hist-'))
  const app = await electron.launch({
    args: electronArgs(),
    env: { ...process.env, AGENT_IDE_DB: dbPath, AGENT_IDE_HISTORY: histDir }
  })
  const win = await app.firstWindow()
  await app
    .context()
    .grantPermissions(['clipboard-read', 'clipboard-write'])
    .catch(() => {})
  await win.waitForSelector('.projrail', { timeout: 15_000 })
  await win.evaluate(async (p) => {
    await window.agentIDE.projectsAddLocal(p)
  }, proj)
  await expect
    .poll(async () => (await win.evaluate(() => window.agentIDE.projectsList())).length, { timeout: 10_000 })
    .toBeGreaterThan(0)
  await win.reload()
  await win.locator('.projrail .pj').first().click({ timeout: 20_000 })

  await win.locator('.provrow.terminal .add').click({ timeout: 20_000 })
  await win.waitForSelector('.terminal-host .xterm', { timeout: 15_000 })

  const id = await win.evaluate(async () => {
    const sessions = (await window.agentIDE.sessionsAll()).filter((s: any) => s.id.startsWith('term-'))
    const t = sessions[sessions.length - 1]
    // Turn ON bracketed paste in the (bash) terminal AND cat -v so control bytes
    // print visibly: bracketed markers render as ^[[200~ ... ^[[201~ under cat -v.
    window.agentIDE.ptyWrite(t.id, `printf '\\033[?2004h'; cat -v\n`)
    return t.id
  })
  await win.waitForTimeout(800)

  // Put a multi-line string on the clipboard via the SAME path the terminal now
  // uses (main's OS clipboard over IPC), not navigator.clipboard — under Xvfb the
  // two aren't guaranteed to share a backing store, and the terminal reads the
  // former. This also exercises clipboard:write end to end.
  await win.evaluate(async () => {
    await window.agentIDE.clipboardWrite('LINE_ONE\nLINE_TWO')
  })
  // Focus the terminal, then fire the paste keybinding (Ctrl+Shift+V) the handler listens for.
  await win.locator('.terminal-host .xterm-helper-textarea').focus()
  await win.keyboard.press('Control+Shift+V')
  await win.waitForTimeout(1000)

  const file = join(histDir, `${id}.log`)
  expect(existsSync(file)).toBe(true)
  const out = readFileSync(file, 'utf8')
  // cat -v renders ESC as ^[, so bracketed-paste markers show as ^[[200~ / ^[[201~.
  // Their presence proves xterm wrapped the paste (bracketed), i.e. NOT raw typed input.
  expect(out).toContain('^[[200~')
  expect(out).toContain('^[[201~')
  // Both pasted lines are present and intact.
  expect(out).toContain('LINE_ONE')
  expect(out).toContain('LINE_TWO')

  await app.close()
})

// Ctrl+Shift+C must copy the terminal SELECTION to the OS clipboard. The old
// path used navigator.clipboard.writeText, which silently no-ops without document
// focus/activation from xterm's keydown handler — so nothing was copied. The fix
// routes copy through main's clipboard (clipboard:write); assert the round-trip.
test('Ctrl+Shift+C copies the terminal selection to the clipboard', async () => {
  const proj = mkdtempSync(join(tmpdir(), 'agide-proj-'))
  mkdirSync(join(proj, 'src'))
  writeFileSync(join(proj, 'README.md'), '# x\n')
  const dbPath = join(mkdtempSync(join(tmpdir(), 'agide-db-')), 'store.sqlite')
  const app = await electron.launch({
    args: [join(__dirname, '..'), '--no-sandbox'],
    env: { ...process.env, AGENT_IDE_DB: dbPath }
  })
  const win = await app.firstWindow()
  await app
    .context()
    .grantPermissions(['clipboard-read', 'clipboard-write'])
    .catch(() => {})
  await win.waitForSelector('.projrail', { timeout: 15_000 })
  await win.evaluate(async (p) => {
    await window.agentIDE.projectsAddLocal(p)
  }, proj)
  await expect
    .poll(async () => (await win.evaluate(() => window.agentIDE.projectsList())).length, { timeout: 10_000 })
    .toBeGreaterThan(0)
  await win.reload()
  await win.locator('.projrail .pj').first().click({ timeout: 20_000 })
  await win.locator('.provrow.terminal .add').click({ timeout: 20_000 })
  await win.waitForSelector('.terminal-host .xterm', { timeout: 15_000 })

  // Clear the clipboard, print a known marker, wait for it to render.
  const MARK = 'COPY_ME_9137'
  await win.evaluate(async (m) => {
    await window.agentIDE.clipboardWrite('')
    const t = (await window.agentIDE.sessionsAll()).filter((s: any) => s.id.startsWith('term-')).pop()
    if (t) window.agentIDE.ptyWrite(t.id, `printf '${m}\\n'\n`)
  }, MARK)
  await expect
    .poll(
      async () =>
        win.evaluate((needle) => {
          const rows = Array.from(
            document.querySelectorAll('.terminal-host .xterm-rows > div')
          ) as HTMLElement[]
          return rows.some((r) => (r.textContent || '').includes(needle))
        }, MARK),
      { timeout: 8_000 }
    )
    .toBe(true)

  // Drag-select the marker row with a real mouse sequence so xterm records a selection.
  const box = await win.evaluate((needle) => {
    const rowsEl = document.querySelector('.terminal-host .xterm-rows') as HTMLElement
    const rows = Array.from(rowsEl.children) as HTMLElement[]
    for (const r of rows) {
      if ((r.textContent || '').includes(needle)) {
        const rc = r.getBoundingClientRect()
        return { x1: rc.left + 2, y: rc.top + rc.height / 2, x2: rc.left + rc.width - 2 }
      }
    }
    return null
  }, MARK)
  expect(box).not.toBeNull()
  await win.mouse.move(box!.x1, box!.y)
  await win.mouse.down()
  await win.mouse.move(box!.x2, box!.y)
  await win.mouse.up()
  await win.locator('.terminal-host .xterm-helper-textarea').focus()
  await win.keyboard.press('Control+Shift+C')

  // The clipboard (read via main) now contains the marker.
  await expect
    .poll(async () => win.evaluate(() => window.agentIDE.clipboardRead()), { timeout: 5_000 })
    .toContain(MARK)

  await app.close()
})
