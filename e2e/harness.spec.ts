import { test, expect, _electron as electron } from '@playwright/test'
import { electronArgs, e2eEnv } from './launch'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// S3 (feat/harness-ux) end-to-end. HOST session only (useContainer=false) so the
// stage advance is the pure label-only path — the container fix-relaunch confirm
// is covered by renderer/integration tests, per the no-container-e2e rule (R6-2,
// R18-2). e2eEnv() prepends the inert provider shims and sets AGENT_IDE_E2E=1.
//
// Flow: launch a session → cockpit stage chip shows 'discussion' → click the
// advance control → chip updates to 'playback'. Then: the harness editor opens
// from the activity bar and round-trips edited text through harness:get/set.

test('stage chip advances discussion→playback on a host session; harness editor round-trips', async () => {
  const base = mkdtempSync(join(tmpdir(), 'agide-harness-'))
  const dbPath = join(base, 'store.sqlite')
  const projectsDir = join(base, 'projects')
  const histDir = mkdtempSync(join(tmpdir(), 'agide-harness-hist-'))
  const harnessDir = mkdtempSync(join(tmpdir(), 'agide-harness-h-'))
  const proj = mkdtempSync(join(tmpdir(), 'agide-harness-proj-'))
  mkdirSync(join(proj, 'src'))
  writeFileSync(join(proj, 'README.md'), '# harness e2e\n')

  const app = await electron.launch({
    args: electronArgs(),
    env: e2eEnv({
      AGENT_IDE_DB: dbPath,
      AGENT_IDE_PROJECTS: projectsDir,
      AGENT_IDE_HISTORY: histDir,
      AGENT_IDE_HARNESS: harnessDir
    })
  })
  const win = await app.firstWindow()
  await win.waitForSelector('.allsessions', { timeout: 20_000 })

  // Register a local project and launch a HOST provider session (inert shim CLI).
  const projectId = await win.evaluate(async (p) => (await window.agentIDE.projectsAddLocal(p)).id, proj)
  const sessionId = await win.evaluate(async ({ projectId, cwd }) => {
    const s = await window.agentIDE.sessionLaunch({
      projectId, provider: 'claude', model: 'claude-opus-4-8', objective: 'harness stage demo',
      cwd, useContainer: false, taskKind: 'product', taskSubkind: 'feature'
    })
    return s.id
  }, { projectId, cwd: proj })

  // The session persisted and is live.
  const fresh = await win.evaluate(async (id) => {
    const s = (await window.agentIDE.sessionsAll()).find((x: any) => x.id === id)
    return { status: s?.status }
  }, sessionId)
  expect(fresh.status).toBe('running')

  // Reload so the renderer hydrates the new session, then open it in the cockpit
  // by selecting the project (rail avatar) and its session card.
  await win.reload()
  await win.waitForSelector('.projrail', { timeout: 20_000 })
  await win.locator('.projrail .pj').first().click()
  await win.waitForSelector('.cockpit', { timeout: 20_000 })
  await win.waitForSelector('.scard', { timeout: 20_000 })
  await win.locator('.scard').first().click()

  // The cockpit header stage control shows the 'discussion' chip.
  const chip = win.locator('.sv-head .stage-chip')
  await expect(chip).toHaveText('Discussion', { timeout: 10_000 })

  // Advance discussion→playback via the adjacent-only advance button (host =
  // label-only, no confirm). The chip updates in place after the reconcile.
  await win.locator('.sv-head .stage-advance').click()
  await expect(chip).toHaveText('Playback', { timeout: 10_000 })

  // The store reflects the applied effectiveStage — a host advance is label-only
  // (reconcile updated effectiveStage in place, no relaunch).
  const advanced = await win.evaluate(async (id) => {
    const s = (await window.agentIDE.sessionsAll()).find((x: any) => x.id === id)
    return { effectiveStage: s?.effectiveStage, status: s?.status }
  }, sessionId)
  expect(advanced.effectiveStage).toBe('playback')
  // The engine was NOT relaunched: the session stays running (no interruption).
  expect(advanced.status).toBe('running')

  // ---- Harness editor round-trip ----
  // Open the editor from the activity-bar 📜 icon.
  await win.locator('.activity .ic[title="Edit session harness"]').click()
  const area = win.locator('.harness-area')
  await expect(area).toBeVisible({ timeout: 10_000 })
  // It loads the current (default) harness text.
  await expect(area).not.toHaveValue('loading…', { timeout: 10_000 })
  const original = await area.inputValue()
  expect(original.length).toBeGreaterThan(0)

  // Edit and Save.
  const marker = 'HARNESS-E2E-ROUNDTRIP-MARKER'
  await area.fill(`${original}\n${marker}\n`)
  await win.locator('.harness-modal .foot button.primary').click()
  await expect(win.locator('.harness-status.ok')).toBeVisible({ timeout: 10_000 })

  // Persisted on disk AND readable back through harness:get.
  const onDisk = readFileSync(join(harnessDir, 'HARNESS.md'), 'utf8')
  expect(onDisk).toContain(marker)
  const roundTripped = await win.evaluate(() => window.agentIDE.harnessGet())
  expect(roundTripped).toContain(marker)

  await app.close()
})
