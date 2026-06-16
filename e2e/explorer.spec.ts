import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Build a throwaway project on disk, then register it through the app's OWN IPC
// (projectsAddLocal) after launch — this avoids loading better-sqlite3 in the
// Playwright/Node process (which has a different ABI than the Electron build).
// Drives the collapsible explorer + file tabs end-to-end.
function seedProjectDir() {
  const proj = mkdtempSync(join(tmpdir(), 'agide-proj-'))
  mkdirSync(join(proj, 'src'))
  writeFileSync(join(proj, 'src', 'hello.ts'), 'export const hi = 1\n')
  writeFileSync(join(proj, 'README.md'), '# readme\n')
  return proj
}

test('explorer: expand a folder and open a file in a new tab', async () => {
  const proj = seedProjectDir()
  const dbPath = join(mkdtempSync(join(tmpdir(), 'agide-db-')), 'store.sqlite')
  const app = await electron.launch({
    args: [join(__dirname, '..'), '--no-sandbox'],
    env: { ...process.env, AGENT_IDE_DB: dbPath }
  })
  const win = await app.firstWindow()
  await win.waitForSelector('.projrail', { timeout: 15_000 })

  // Register the project via the real IPC and confirm it persisted, THEN reload
  // so boot() re-hydrates it (poll the store to avoid a reload/persist race).
  await win.evaluate(async (p) => { await window.agentIDE.projectsAddLocal(p) }, proj)
  await expect.poll(
    async () => (await win.evaluate(() => window.agentIDE.projectsList())).length,
    { timeout: 10_000 }
  ).toBeGreaterThan(0)
  await win.reload()

  // Open the project from the rail.
  await win.waitForSelector('.projrail .pj', { timeout: 15_000 })
  await win.locator('.projrail .pj').first().click()

  // Explorer shows the top level: a 'src' folder and 'README.md', collapsed.
  await win.waitForSelector('.explorer .ex-list', { timeout: 10_000 })
  await expect(win.locator('.ex-i', { hasText: 'src' })).toHaveCount(1)
  await expect(win.locator('.ex-i', { hasText: 'hello.ts' })).toHaveCount(0) // not expanded yet

  // Expand 'src' → its child file appears (lazy fs:dir fetch).
  await win.locator('.ex-i', { hasText: 'src' }).click()
  await expect(win.locator('.ex-i', { hasText: 'hello.ts' })).toHaveCount(1)

  // Collapse again → child hidden.
  await win.locator('.ex-i', { hasText: 'src' }).click()
  await expect(win.locator('.ex-i', { hasText: 'hello.ts' })).toHaveCount(0)

  // Re-expand and open the file → a file tab appears and the editor shows content.
  await win.locator('.ex-i', { hasText: 'src' }).click()
  await win.locator('.ex-i', { hasText: 'hello.ts' }).click()
  await expect(win.locator('.ed-tab.file', { hasText: 'hello.ts' })).toHaveCount(1)
  await expect(win.locator('.fe-area')).toHaveValue(/export const hi = 1/)

  // Close the tab → back to the session tab, editor gone.
  await win.locator('.ed-tab.file .close').click()
  await expect(win.locator('.ed-tab.file')).toHaveCount(0)
  await expect(win.locator('.fe-area')).toHaveCount(0)

  await app.close()
  rmSync(proj, { recursive: true, force: true })
})
