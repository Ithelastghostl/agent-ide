import { test, expect, _electron as electron } from '@playwright/test'
import { electronArgs, e2eEnv } from './launch'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Resizing the window must reflow the terminal — BOTH axes — and propagate the
// new cols/rows to the pty so the running program redraws. This is the
// regression that shipped broken: @xterm/addon-fit@0.11 read xterm-5 internals
// (_core._renderService) that @xterm/xterm@6 removed, so fit() silently no-oped
// and the terminal stayed at its initial grid forever (SessionTerminal now
// hand-rolls fitToHost() from public geometry).
//
// Proof is end to end: `stty size` inside the real pty shell reports what the
// KERNEL believes the terminal size is — it can only change if renderer fit →
// term.resize → onResize → ptyResize → ioctl all fired.

async function sttySize(win: import('@playwright/test').Page, marker: string): Promise<{ rows: number; cols: number }> {
  await win.evaluate(
    async ({ m }) => {
      const sessions = await window.agentIDE.sessionsAll()
      const term = sessions.filter((s: { id: string }) => s.id.startsWith('term-')).pop()
      if (term) window.agentIDE.ptyWrite(term.id, `echo ${m} $(stty size)\n`)
    },
    { m: marker }
  )
  let out = { rows: 0, cols: 0 }
  await expect
    .poll(
      async () => {
        const texts = await win.evaluate(() =>
          Array.from(document.querySelectorAll('.terminal-host .xterm-rows > div')).map((r) => r.textContent || '')
        )
        // Match the echoed result ("MARKER 40 120"), not the typed command line
        // (which contains "$(stty size)").
        const re = new RegExp(`${marker} (\\d+) (\\d+)\\s*$`)
        for (const t of texts) {
          const m = t.match(re)
          if (m) {
            out = { rows: Number(m[1]), cols: Number(m[2]) }
            return true
          }
        }
        return false
      },
      { timeout: 10_000 }
    )
    .toBe(true)
  return out
}

test('window resize reflows the terminal grid and the pty (both axes)', async () => {
  const proj = mkdtempSync(join(tmpdir(), 'agide-proj-'))
  mkdirSync(join(proj, 'src'))
  writeFileSync(join(proj, 'README.md'), '# x\n')
  const dbPath = join(mkdtempSync(join(tmpdir(), 'agide-db-')), 'store.sqlite')
  const app = await electron.launch({
    args: electronArgs(),
    env: e2eEnv({ AGENT_IDE_DB: dbPath })
  })
  const win = await app.firstWindow()
  await win.waitForSelector('.projrail', { timeout: 20_000 })
  await win.evaluate(async (p) => {
    await window.agentIDE.projectsAddLocal(p)
  }, proj)
  await expect
    .poll(async () => (await win.evaluate(() => window.agentIDE.projectsList())).length, { timeout: 15_000 })
    .toBeGreaterThan(0)
  await win.reload()
  await win.locator('.projrail .pj').first().click({ timeout: 20_000 })
  await win.locator('.provrow.terminal .add').click({ timeout: 20_000 })
  await win.waitForSelector('.terminal-host .xterm', { timeout: 15_000 })

  const setSize = (w: number, h: number) =>
    app.evaluate(({ BrowserWindow }, s) => {
      const bw = BrowserWindow.getAllWindows()[0]
      bw.setSize(s.w, s.h)
    }, { w, h })

  await setSize(1280, 900)
  const large = await sttySize(win, 'SZL')

  // Shrink height only → rows must drop (the vertical axis of the regression).
  await setSize(1280, 560)
  await expect
    .poll(async () => (await sttySize(win, `SZV${Date.now()}`)).rows, { timeout: 10_000 })
    .toBeLessThan(large.rows)

  // Shrink width only → cols must drop.
  await setSize(760, 560)
  await expect
    .poll(async () => (await sttySize(win, `SZH${Date.now()}`)).cols, { timeout: 10_000 })
    .toBeLessThan(large.cols)

  // Grow back → both must grow again (fit is live, not one-shot).
  await setSize(1280, 900)
  const restored = await sttySize(win, 'SZR')
  expect(restored.rows).toBeGreaterThan(large.rows - 3)
  expect(restored.cols).toBeGreaterThan(large.cols - 3)

  await app.close()
})
