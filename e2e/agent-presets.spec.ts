import { test, expect, _electron as electron } from '@playwright/test'
import { electronArgs, e2eEnv } from './launch'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// S8 (agent presets): the "Launch session" action on a library agent opens the
// model picker prefilled from the agent's description; confirming launches a
// session bound to that agent's relPath (persisted), and the session renders an
// agent chip. No container sessions in e2e (R6-2); the provider shim on PATH
// (e2eEnv) makes the launch inert.
test('launch a session from a library agent → agentRelPath persisted + chip renders', async () => {
  const proj = mkdtempSync(join(tmpdir(), 'agide-proj-'))
  mkdirSync(join(proj, 'src'))
  writeFileSync(join(proj, 'README.md'), '# x\n')
  const dbPath = join(mkdtempSync(join(tmpdir(), 'agide-db-')), 'store.sqlite')
  const histDir = mkdtempSync(join(tmpdir(), 'agide-hist-'))
  const libDir = mkdtempSync(join(tmpdir(), 'agide-lib-'))
  const harnessDir = mkdtempSync(join(tmpdir(), 'agide-harness-'))
  mkdirSync(join(libDir, 'agents'), { recursive: true })

  const app = await electron.launch({
    args: electronArgs(),
    env: e2eEnv({
      AGENT_IDE_DB: dbPath,
      AGENT_IDE_HISTORY: histDir,
      AGENT_IDE_LIBRARY: libDir,
      AGENT_IDE_HARNESS: harnessDir
    })
  })
  const win = await app.firstWindow()
  await win.waitForSelector('.projrail', { timeout: 20_000 })

  // Seed a project and a library agent through the bridge.
  await win.evaluate(async (p) => {
    await window.agentIDE.projectsAddLocal(p)
  }, proj)
  const added = await win.evaluate(() =>
    window.agentIDE.libraryAddAgent({
      name: 'Release Writer',
      description: 'write terse release notes',
      instructions: 'Write terse notes.',
      data: 'style: terse',
      context: 'for the IDE repo'
    })
  )
  expect((added as { relPath?: string }).relPath).toBe('agents/release-writer.md')

  await expect
    .poll(async () => (await win.evaluate(() => window.agentIDE.projectsList())).length, { timeout: 15_000 })
    .toBeGreaterThan(0)
  await win.reload()
  await win.locator('.projrail .pj').first().click({ timeout: 20_000 })

  // Open the Agents panel via its cockpit pill.
  await expect
    .poll(
      async () =>
        win.evaluate(() => {
          const pills = Array.from(document.querySelectorAll('.libpills .pill')).map(
            (p) => p.textContent || ''
          )
          return pills.join(' | ')
        }),
      { timeout: 10_000 }
    )
    .toContain('Agents1')
  await win.locator('.libpills .pill', { hasText: 'Agents' }).click()
  await win.waitForSelector('.modal .mopt', { timeout: 8_000 })

  // Click "Launch session" on the agent → the task-label choosers appear first
  // (host project, so no container prompt), then the model picker opens PREFILLED.
  await win.locator('.modal .lib-launch').click()
  await win.locator('.modal .foot button', { hasText: 'Product' }).click()
  await win.locator('.modal .foot button', { hasText: 'Feature' }).click()
  await win.waitForSelector('.mp-objective', { timeout: 8_000 })
  // Objective is prefilled from the agent description; provider tabs present.
  await expect(win.locator('.mp-objective')).toHaveValue('write terse release notes')
  await expect(win.locator('.modal h3')).toContainText('Release Writer')
  await expect(win.locator('.mp-provtab')).toHaveCount(3)

  // Confirm on the first model → a session is launched with the agent's relPath.
  await win.locator('.modal .mopt').first().click()
  await win.waitForSelector('.terminal-host .xterm', { timeout: 15_000 })

  // The persisted session carries agentRelPath, and it was NOT a container launch.
  await expect
    .poll(
      async () =>
        win.evaluate(async () => {
          const all = await window.agentIDE.sessionsAll()
          const s = all.filter((x: any) => !x.id.startsWith('term-')).pop()
          return s?.agentRelPath ?? null
        }),
      { timeout: 10_000 }
    )
    .toBe('agents/release-writer.md')
  const useContainer = await win.evaluate(async () => {
    const all = await window.agentIDE.sessionsAll()
    const s = all.filter((x: any) => !x.id.startsWith('term-')).pop()
    return s?.useContainer
  })
  expect(useContainer).toBe(false)

  // The agent chip renders on the session (header and/or card).
  await expect
    .poll(
      async () =>
        win.evaluate(() => {
          const chips = Array.from(document.querySelectorAll('.agent-chip')).map((c) => c.textContent || '')
          return chips.join(' | ')
        }),
      { timeout: 8_000 }
    )
    .toContain('Release Writer')

  await app.close()
})
