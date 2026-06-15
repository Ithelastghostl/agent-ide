import { test, expect, _electron as electron } from '@playwright/test'
import { join } from 'path'

// Verifies the launcher → model picker UI (D3 full list). Does NOT launch a real
// provider CLI (that would hit the subscription / interactive auth).
test('clicking a provider launcher opens the full model picker', async () => {
  const app = await electron.launch({ args: [join(__dirname, '..'), '--no-sandbox'] })
  const win = await app.firstWindow()

  await win.waitForSelector('.cockpit .launch button.claude', { timeout: 15_000 })
  await win.locator('.cockpit .launch button.claude').click()

  // Modal appears, titled for Claude, with the full model list (haiku/sonnet/opus).
  await win.waitForSelector('.modal-wrap.show', { timeout: 5_000 })
  await expect(win.locator('.modal h3')).toContainText('Claude')
  const opts = win.locator('.modal .mopt')
  await expect(opts).toHaveCount(3)
  await expect(win.locator('.modal .mscroll')).toContainText('claude-opus-4.8')

  // Cancel closes it (no session launched).
  await win.locator('.modal .foot button').click()
  await expect(win.locator('.modal-wrap.show')).toHaveCount(0)

  await app.close()
})
