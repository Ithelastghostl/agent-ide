import { test, expect, _electron as electron } from '@playwright/test'
import { join } from 'path'

// The app boots empty (F1): no project loaded, home board + "Open project" CTA.
test('app boots to an empty home board with an Open project action', async () => {
  const app = await electron.launch({ args: [join(__dirname, '..'), '--no-sandbox'] })
  const win = await app.firstWindow()

  // home board renders
  await win.waitForSelector('.allsessions', { timeout: 15_000 })
  await expect(win.locator('.allsessions h2')).toContainText('All sessions')

  // the project rail shows the home button + add button (project avatars may or
  // may not exist depending on the persisted store — F1 opens on home regardless)
  await expect(win.locator('.projrail .home')).toHaveCount(1)
  await expect(win.locator('.projrail .add')).toHaveCount(1)

  // the F1 "Open project" CTA is present
  await expect(win.locator('.open-cta')).toContainText('Open project')

  await app.close()
})

// Clicking "Open project" / rail + opens the add-project menu (F2).
test('Open project opens the add-project menu with three ways', async () => {
  const app = await electron.launch({ args: [join(__dirname, '..'), '--no-sandbox'] })
  const win = await app.firstWindow()

  await win.waitForSelector('.open-cta', { timeout: 15_000 })
  await win.locator('.open-cta').click()

  await win.waitForSelector('#app-menu', { timeout: 5_000 })
  const items = win.locator('#app-menu .ctx-item')
  await expect(items).toHaveCount(3)
  await expect(win.locator('#app-menu')).toContainText('Open existing folder')
  await expect(win.locator('#app-menu')).toContainText('Clone from GitHub')
  await expect(win.locator('#app-menu')).toContainText('Clone from git URL')

  await app.close()
})
