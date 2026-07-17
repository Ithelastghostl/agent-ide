import { test, expect, _electron as electron } from '@playwright/test'
import { electronArgs, e2eEnv } from './launch'
import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// S4 git supervision (read-only): a temp git repo with one commit + an
// uncommitted edit. The rail shows the branch badge; the Diff tab shows the
// seeded working-tree change. No mutation — read-only awareness only.
function seedGitProject(): string {
  const proj = mkdtempSync(join(tmpdir(), 'agide-git-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', proj, ...args], { stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  writeFileSync(join(proj, 'app.ts'), 'export const x = 1\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'initial')
  // Uncommitted edit — this is what the Diff tab must surface.
  writeFileSync(join(proj, 'app.ts'), 'export const x = 1\nexport const y = 2 // SEEDED_DIFF_LINE\n')
  return proj
}

test('git supervision: rail branch badge + read-only Diff tab shows the seeded change', async () => {
  const proj = seedGitProject()
  const dbPath = join(mkdtempSync(join(tmpdir(), 'agide-db-')), 'store.sqlite')
  const app = await electron.launch({
    args: electronArgs(),
    env: e2eEnv({ AGENT_IDE_DB: dbPath })
  })
  const win = await app.firstWindow()
  await win.waitForSelector('.projrail', { timeout: 15_000 })

  // Register the git project via the real IPC, wait for persistence, then reload
  // so boot() re-hydrates it (same pattern as explorer.spec.ts).
  await win.evaluate(async (p) => { await window.agentIDE.projectsAddLocal(p) }, proj)
  await expect.poll(
    async () => (await win.evaluate(() => window.agentIDE.projectsList())).length,
    { timeout: 10_000 }
  ).toBeGreaterThan(0)
  await win.reload()

  // Open the project from the rail.
  await win.locator('.projrail .pj').first().click({ timeout: 20_000 })

  // Rail badge shows the branch ("main"). It is fetched async after open.
  await expect(win.locator('.projrail .pj .gitbadge')).toContainText('main', { timeout: 15_000 })

  // A Diff tab appears (git repo detected). Open it.
  await win.waitForSelector('.ed-tab.diff', { timeout: 15_000 })
  await win.locator('.ed-tab.diff').click()

  // The read-only diff pane shows the seeded working-tree change.
  const body = win.locator('.diff-pane .diff-body')
  await expect(body).toBeVisible()
  await expect(body).toContainText('app.ts', { timeout: 10_000 })
  await expect(body).toContainText('SEEDED_DIFF_LINE')

  // Read-only: no write/rollback controls in the diff pane.
  await expect(win.locator('.diff-pane button')).toHaveCount(0)

  await app.close()
})
