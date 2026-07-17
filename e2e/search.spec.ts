import { test, expect, _electron as electron } from '@playwright/test'
import { electronArgs, e2eEnv } from './launch'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// S7 ⌘K search end-to-end: seed a transcript AND a backlog item that both contain
// a distinctive term, open the overlay, and assert BOTH a transcript hit and a
// backlog hit render — then that Enter navigates. Driven against the real Electron
// main + the inert provider shims (e2eEnv), so no real CLI is reached and no
// container is launched. FTS syntax chars must not error (foundation escapes them).
test('⌘K finds a seeded transcript and backlog item, and Enter navigates', async () => {
  const base = mkdtempSync(join(tmpdir(), 'agide-search-'))
  const dbPath = join(base, 'store.sqlite')
  const projectsDir = join(base, 'projects')
  const histDir = mkdtempSync(join(tmpdir(), 'agide-hist-'))
  const proj = mkdtempSync(join(tmpdir(), 'agide-proj-'))
  const TERM = 'zebrafish' // present in both the transcript and the backlog item

  const app = await electron.launch({
    args: electronArgs(),
    env: e2eEnv({ AGENT_IDE_DB: dbPath, AGENT_IDE_PROJECTS: projectsDir, AGENT_IDE_HISTORY: histDir })
  })
  const win = await app.firstWindow()
  await win.waitForSelector('.projrail', { timeout: 15_000 })

  // Register a local project.
  const projectId = await win.evaluate(async (p) => (await window.agentIDE.projectsAddLocal(p)).id, proj)

  // Seed a BACKLOG item whose title carries the term (backlog_fts indexes title+body).
  const backlogItemId = await win.evaluate(async ({ projectId, term }) => {
    const r = await window.agentIDE.backlogCreate({
      projectId, kind: 'task', title: `${term} migration`, bodyMd: `Investigate the ${term} pipeline.`
    })
    return r.item?.id as string
  }, { projectId, term: TERM })
  expect(backlogItemId).toBeTruthy()

  // Seed a TRANSCRIPT: launch a provider session (inert shim), write the term into
  // its pty; the shim echoes stdin, which main records to the transcript + FTS.
  const sessionId = await win.evaluate(async ({ projectId, cwd, term }) => {
    const s = await window.agentIDE.sessionLaunch({
      projectId, provider: 'claude', model: 'claude-opus-4-8', objective: 'search seed',
      cwd, useContainer: false, taskKind: 'analysis'
    })
    // Newline so the shim's `cat` flushes the line back as output.
    window.agentIDE.ptyWrite(s.id, `${term} in the transcript\n`)
    return s.id as string
  }, { projectId, cwd: proj, term: TERM })
  expect(sessionId).toBeTruthy()

  // The transcript write flows through the pty + a flush debounce; poll the store
  // via searchQuery until BOTH hit types are present for the term.
  await expect.poll(async () => {
    return win.evaluate(async (term) => {
      const hits = await window.agentIDE.searchQuery(term, 50)
      return {
        transcript: hits.some((h: any) => h.type === 'transcript'),
        backlog: hits.some((h: any) => h.type === 'backlog')
      }
    }, TERM)
  }, { timeout: 15_000, intervals: [250, 500, 1000] }).toEqual({ transcript: true, backlog: true })

  // FTS syntax chars must not error (foundation escapes user input): quotes/parens.
  const messy = await win.evaluate((term) => window.agentIDE.searchQuery(`"${term}" (foo`, 50).then(() => 'ok').catch((e) => `err:${e}`), TERM)
  expect(messy).toBe('ok')

  // Reload so the renderer hydrates the seeded project + session from the store
  // (the project was added after boot). Transcript navigation opens that project's
  // cockpit, which requires it to be present in renderer state.
  await win.reload()
  await win.waitForSelector('.projrail', { timeout: 15_000 })

  // Open the ⌘K overlay via the keybinding and type the term.
  await win.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K')
  await win.waitForSelector('.search-overlay .search-input', { timeout: 10_000 })
  await win.locator('.search-input').fill(TERM)

  // Both a transcript row and a backlog row must render, grouped.
  await expect(win.locator('.search-group', { hasText: 'Transcripts' })).toBeVisible({ timeout: 10_000 })
  await expect(win.locator('.search-group', { hasText: 'Backlog' })).toBeVisible({ timeout: 10_000 })
  await expect(win.locator('.search-row.transcript')).toHaveCount(1)
  await expect(win.locator('.search-row.backlog').first()).toBeVisible()
  await expect(win.locator('.search-row.backlog .sr-name').first()).toHaveText(`${TERM} migration`)

  // Enter on the FIRST hit (a transcript) navigates: overlay closes and the
  // cockpit renders for the hit's project (observable via the editor/terminal).
  await win.keyboard.press('Enter')
  await expect(win.locator('.search-overlay')).toHaveCount(0)
  await expect(win.locator('.editor')).toBeVisible({ timeout: 10_000 })

  // Re-open and Enter on the BACKLOG hit → routes to the Backlog view focused on it.
  await win.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K')
  await win.waitForSelector('.search-overlay .search-input', { timeout: 10_000 })
  await win.locator('.search-input').fill(TERM)
  await expect(win.locator('.search-row.backlog').first()).toBeVisible({ timeout: 10_000 })
  await win.locator('.search-row.backlog').first().click()
  await expect(win.locator('.search-overlay')).toHaveCount(0)
  await expect(win.locator('.backlog-view')).toBeVisible({ timeout: 10_000 })
  // S1's full Backlog view highlights the search-routed item (.bk-focused on the
  // element carrying its data-id). (S7's placeholder .backlog-focus was superseded
  // by S1's BacklogView during consolidation.)
  await expect(win.locator(`.backlog-view [data-id="${backlogItemId}"].bk-focused`)).toBeVisible({ timeout: 10_000 })

  await app.close()
})
