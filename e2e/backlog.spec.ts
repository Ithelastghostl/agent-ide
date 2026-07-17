import { test, expect, _electron as electron } from '@playwright/test'
import { electronArgs, e2eEnv } from './launch'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// S1 Backlog end-to-end (real Electron main): create an item through the UI and
// see it in the table; drop a markdown file into backlog/inbox and see it ingested;
// select an item and launch a plain terminal → the session_backlog join exists and
// the item's sessionState becomes 'in-session'. No provider CLI is invoked (plain
// terminal only); AGENT_IDE_E2E=1 keeps everything host-side.
test('backlog: UI create, inbox ingest, and "work on this" binding', async () => {
  const base = mkdtempSync(join(tmpdir(), 'agide-backlog-'))
  const dbPath = join(base, 'store.sqlite')
  const projectsDir = join(base, 'projects')
  const proj = mkdtempSync(join(tmpdir(), 'agide-bkproj-'))

  const app = await electron.launch({
    args: electronArgs(),
    env: e2eEnv({ AGENT_IDE_DB: dbPath, AGENT_IDE_PROJECTS: projectsDir })
  })
  const win = await app.firstWindow()
  await win.waitForSelector('.allsessions', { timeout: 15_000 })

  // Register a local project (main resolves its confined root by id), then reload
  // so the renderer re-hydrates projects from the store and the rail shows it.
  const projectId = await win.evaluate(async (p) => (await window.agentIDE.projectsAddLocal(p)).id, proj)
  await win.reload()
  await win.waitForSelector('.projrail .pj', { timeout: 15_000 })

  // Select the project by clicking its rail avatar, then open the Backlog tab.
  await win.locator('.projrail .pj').first().click()
  await win.locator('.activity .backlog-tab').click()
  await win.waitForSelector('.backlog-view', { timeout: 5_000 })

  // --- create an item through the UI ---
  await win.locator('.bk-new').click()
  await win.waitForSelector('.bk-modal', { timeout: 5_000 })
  await win.locator('.bk-modal input[type="text"].bk-input').fill('Ship the widget')
  await win.locator('.bk-modal .bk-textarea').fill('Do the whole thing.')
  await win.locator('.bk-modal .foot button.primary').click()

  // Switch to table view and confirm the created item shows.
  await win.locator('.bk-tg[data-layout="table"]').click()
  await expect(win.locator('.bk-table .bk-c.title', { hasText: 'Ship the widget' })).toHaveCount(1, { timeout: 5_000 })

  // --- drop a markdown file into backlog/inbox and see it ingested ---
  const inboxDir = join(proj, 'backlog', 'inbox')
  mkdirSync(inboxDir, { recursive: true })
  writeFileSync(join(inboxDir, 'dropped.md'), '---\nkind: goal\ntitle: Dropped from inbox\n---\nInbox body.\n')

  // The watcher settles at 500ms + rescans on an interval; poll the store.
  let ingested = false
  for (let i = 0; i < 20 && !ingested; i++) {
    ingested = await win.evaluate(async (id) => (await window.agentIDE.backlogList(id)).some((it) => it.title === 'Dropped from inbox'), projectId)
    if (!ingested) await new Promise((r) => setTimeout(r, 1000))
  }
  expect(ingested).toBe(true)

  // --- select an item and "work on this" via a plain terminal launch ---
  // Grab the created item's id, then launch a terminal carrying it as a backlog
  // selection (the bridge passes backlogItemIds through; main binds it).
  const itemId = await win.evaluate(async (id) =>
    (await window.agentIDE.backlogList(id)).find((i) => i.title === 'Ship the widget')!.id, projectId)

  const sessionId = await win.evaluate(async ({ projectId, cwd, itemId }) => {
    const s = await window.agentIDE.terminalOpen(
      { projectId, cwd, name: 'work', useContainer: false, backlogItemIds: [itemId] } as unknown as Parameters<typeof window.agentIDE.terminalOpen>[0]
    )
    return s.id
  }, { projectId, cwd: proj, itemId })

  // the session_backlog join row exists…
  const bound = await win.evaluate(async (sid) => window.agentIDE.backlogForSession(sid), sessionId)
  expect(bound).toContain(itemId)

  // …and the item's sessionState is now 'in-session'.
  const sessionState = await win.evaluate(async ({ projectId, itemId }) =>
    (await window.agentIDE.backlogList(projectId)).find((i) => i.id === itemId)!.sessionState,
    { projectId, itemId })
  expect(sessionState).toBe('in-session')

  await app.close()
})
