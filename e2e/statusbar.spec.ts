import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// F16: the bottom status bar probes external-service CLIs on startup and shows
// online/offline per service; clicking a chip re-checks (online) or opens a login
// terminal (offline). gh is installed + logged in on this host, so GitHub should
// resolve to "online"; the rest are offline/not-installed here.
test('status bar shows service connectivity and opens a login terminal on click', async () => {
  const proj = mkdtempSync(join(tmpdir(), 'agide-proj-'))
  mkdirSync(join(proj, 'src')); writeFileSync(join(proj, 'README.md'), '# x\n')
  const dbPath = join(mkdtempSync(join(tmpdir(), 'agide-db-')), 'store.sqlite')
  const app = await electron.launch({ args: [join(__dirname, '..'), '--no-sandbox'], env: { ...process.env, AGENT_IDE_DB: dbPath } })
  const win = await app.firstWindow()
  await win.waitForSelector('.statusbar', { timeout: 20_000 })

  // Open a project so the cockpit (and a clicked login terminal) can render.
  await win.evaluate(async (p) => { await window.agentIDE.projectsAddLocal(p) }, proj)
  await expect.poll(async () => (await win.evaluate(() => window.agentIDE.projectsList())).length, { timeout: 15_000 }).toBeGreaterThan(0)
  await win.reload()
  await win.locator('.projrail .pj').first().click({ timeout: 20_000 })
  await win.waitForSelector('.statusbar', { timeout: 10_000 })

  // Four service chips render.
  await expect(win.locator('.sb-chip')).toHaveCount(4)
  const names = await win.locator('.sb-chip .sb-name').allTextContents()
  expect(names).toEqual(['Vercel', 'Supabase', 'GitHub', 'Resend'])

  // After the startup probe resolves, GitHub should be online (gh is authed here).
  const github = win.locator('.sb-chip', { hasText: 'GitHub' })
  await expect(github).toHaveClass(/online/, { timeout: 15_000 })
  await expect(github.locator('.sb-state')).toHaveText('online')

  // A not-installed service (Resend) shows an offline-ish state…
  const resend = win.locator('.sb-chip', { hasText: 'Resend' })
  await expect(resend).toHaveClass(/not-installed|not-logged-in/, { timeout: 15_000 })

  // …and clicking it opens a login terminal, surfaced as the active session tab.
  // (Login sessions aren't persisted to the store — like provider:login — so we
  // assert on the visible UI: a terminal mounts and the active tab names it.)
  await resend.click()
  await win.waitForSelector('.terminal-host .xterm', { timeout: 10_000 })
  await expect(win.locator('.ed-tabs')).toContainText('resend login', { timeout: 8_000 })

  await app.close()
})
