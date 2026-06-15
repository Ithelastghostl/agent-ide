import { test, expect, _electron as electron } from '@playwright/test'
import { join } from 'path'

// Verifies the ⌘ home global cross-project session board (NN4).
test('clicking ⌘ home shows all sessions across projects', async () => {
  const app = await electron.launch({ args: [join(__dirname, '..'), '--no-sandbox'] })
  const win = await app.firstWindow()

  await win.waitForSelector('.projrail .home', { timeout: 15_000 })
  await win.locator('.projrail .home').click()

  await win.waitForSelector('.allsessions', { timeout: 5_000 })
  // mock state seeds sessions in 3 projects -> board groups them
  const groups = win.locator('.as-proj')
  expect(await groups.count()).toBeGreaterThanOrEqual(2)
  await expect(win.locator('.allsessions h2')).toContainText('All sessions')

  // clicking a session row navigates into a project (board disappears)
  await win.locator('.as-row').first().click()
  await expect(win.locator('.allsessions')).toHaveCount(0)
  await expect(win.locator('.cockpit')).toHaveCount(1)

  await app.close()
})
