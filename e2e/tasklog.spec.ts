import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// M-LOG-a end-to-end (in the real Electron main): a labeled PRODUCT agent session
// persists its task label, and marking it finished writes the raw log entry;
// validation rejects an unlabeled agent launch. Driven via the IPC bridge (like
// the other specs) so it needs no modal-clicking or a real provider CLI — the
// spawn may fail without a CLI, but the session row + label + export are what we
// assert (the transcript is simply empty).
test('a product task persists its label and exports a raw log on finish', async () => {
  const base = mkdtempSync(join(tmpdir(), 'agide-tasklog-'))
  const dbPath = join(base, 'store.sqlite')
  const projectsDir = join(base, 'projects')
  const proj = mkdtempSync(join(tmpdir(), 'agide-proj-'))

  const app = await electron.launch({
    args: [join(__dirname, '..'), '--no-sandbox', '--ozone-platform=x11'],
    env: { ...process.env, AGENT_IDE_DB: dbPath, AGENT_IDE_PROJECTS: projectsDir }
  })
  const win = await app.firstWindow()
  await win.waitForSelector('.allsessions', { timeout: 15_000 })

  // register a local project, then launch a labeled product session via IPC
  const projectId = await win.evaluate(async (p) => {
    const project = await window.agentIDE.projectsAddLocal(p)
    return project.id
  }, proj)

  const launched = await win.evaluate(async ({ projectId, cwd }) => {
    try {
      const s = await window.agentIDE.sessionLaunch({
        projectId, provider: 'claude', model: 'claude-opus-4-8', objective: 'ship the widget',
        cwd, useContainer: false, taskKind: 'product', taskSubkind: 'feature'
      })
      return { id: s.id, taskKind: s.taskKind, taskSubkind: s.taskSubkind, taskStatus: s.taskStatus }
    } catch (e) {
      return { error: String(e) }
    }
  }, { projectId, cwd: proj })

  // the session was created and carries its label (even if the CLI spawn had no
  // output, the row + label persist)
  expect(launched.error).toBeUndefined()
  expect(launched.taskKind).toBe('product')
  expect(launched.taskSubkind).toBe('feature')
  expect(launched.taskStatus).toBe('open')

  // an UNLABELED agent launch is rejected by the main-side validator (M-LOG-a)
  const unlabeled = await win.evaluate(async ({ projectId, cwd }) => {
    try {
      await window.agentIDE.sessionLaunch({ projectId, provider: 'claude', model: 'claude-opus-4-8', objective: 'x', cwd, useContainer: false } as any)
      return 'accepted'
    } catch (e) {
      return 'rejected'
    }
  }, { projectId, cwd: proj })
  expect(unlabeled).toBe('rejected')

  // mark finished → main writes the raw log entry for this product task
  const res = await win.evaluate((id) => window.agentIDE.taskSetStatus(id, 'finished'), launched.id!)
  expect(res.error).toBeUndefined()

  const logPath = join(projectsDir, projectId, 'log', 'raw', `${launched.id}.md`)
  expect(existsSync(logPath)).toBe(true)
  const body = readFileSync(logPath, 'utf8')
  expect(body).toContain('task_kind: product')
  expect(body).toContain('task_subkind: feature')

  await app.close()
})
