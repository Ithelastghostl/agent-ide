import { test, expect, _electron as electron } from '@playwright/test'
import { join } from 'path'

// Requires a display. Run with: xvfb-run -a npm run e2e
test('a session shows a live terminal that echoes typed input', async () => {
  const app = await electron.launch({
    args: [join(__dirname, '..'), '--no-sandbox']
  })
  const win = await app.firstWindow()

  // The active mock session (s1) mounts a bash terminal in the supervision pane.
  await win.waitForSelector('.terminal-host .xterm', { timeout: 15_000 })

  // Type into the focused terminal and expect the echo to appear in the buffer.
  await win.locator('.terminal-host .xterm').click()
  await win.keyboard.type('echo hi-from-e2e\n')

  await expect(async () => {
    const text = await win.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '')
    expect(text).toContain('hi-from-e2e')
  }).toPass({ timeout: 10_000 })

  await app.close()
})
