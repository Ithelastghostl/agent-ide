import { test, expect, _electron as electron } from '@playwright/test'
import { electronArgs } from './launch'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// The window uses titleBarStyle 'hiddenInset' (src/main/index.ts), which removes
// the native macOS title bar — without a renderer drag region the window cannot
// be dragged (e.g. between displays). The .titlebar strip must exist as a real,
// nonzero drag surface on EVERY view path, and must not swallow clicks on the
// app's interactive controls.

async function dragRegion(win: Awaited<ReturnType<Awaited<ReturnType<typeof electron.launch>>['firstWindow']>>) {
  return win.evaluate(() => {
    const el = document.querySelector('.titlebar')
    if (!el) return { present: false, region: '', w: 0, h: 0 }
    const r = el.getBoundingClientRect()
    return {
      present: true,
      region: getComputedStyle(el).getPropertyValue('-webkit-app-region').trim(),
      w: r.width,
      h: r.height
    }
  })
}

test('home board has a nonzero titlebar drag region and controls still click', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'agide-tb-')), 'store.sqlite')
  const app = await electron.launch({ args: electronArgs(), env: { ...process.env, AGENT_IDE_DB: dbPath } })
  const win = await app.firstWindow()
  await win.waitForSelector('.allsessions', { timeout: 15_000 })

  const tb = await dragRegion(win)
  expect(tb.present).toBe(true)
  expect(tb.region).toBe('drag')
  expect(tb.w).toBeGreaterThan(0)
  expect(tb.h).toBeGreaterThan(0)

  // Interactive controls outside the strip still receive clicks.
  await win.locator('.open-cta').click()
  await win.waitForSelector('#app-menu', { timeout: 5_000 })

  await app.close()
})

test('project cockpit view keeps the titlebar drag region', async () => {
  const proj = mkdtempSync(join(tmpdir(), 'agide-tb-proj-'))
  mkdirSync(join(proj, 'src')); writeFileSync(join(proj, 'README.md'), '# x\n')
  const dbPath = join(mkdtempSync(join(tmpdir(), 'agide-tb-db-')), 'store.sqlite')
  const app = await electron.launch({ args: electronArgs(), env: { ...process.env, AGENT_IDE_DB: dbPath } })
  const win = await app.firstWindow()
  await win.waitForSelector('.projrail', { timeout: 20_000 })
  await win.evaluate(async (p) => { await window.agentIDE.projectsAddLocal(p) }, proj)
  await expect.poll(async () => (await win.evaluate(() => window.agentIDE.projectsList())).length, { timeout: 15_000 }).toBeGreaterThan(0)
  await win.reload()
  await win.locator('.projrail .pj').first().click({ timeout: 20_000 })
  await win.waitForSelector('.cp-title', { timeout: 15_000 })

  const tb = await dragRegion(win)
  expect(tb.present).toBe(true)
  expect(tb.region).toBe('drag')
  expect(tb.w).toBeGreaterThan(0)
  expect(tb.h).toBeGreaterThan(0)

  await app.close()
})
