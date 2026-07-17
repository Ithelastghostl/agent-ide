import { test, expect, _electron as electron } from '@playwright/test'
import { electronArgs } from './launch'
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

  // The ticket pass is pinned to the deterministic FAILING fixture: the default
  // runner is now the real claude CLI, which an e2e must never invoke (billed).
  const app = await electron.launch({
    args: electronArgs(),
    env: {
      ...process.env,
      AGENT_IDE_DB: dbPath,
      AGENT_IDE_PROJECTS: projectsDir,
      AGENT_IDE_TICKET_CMD: JSON.stringify(['node', join(__dirname, 'fixtures', 'ticket-fail.js')])
    }
  })
  const win = await app.firstWindow()
  await win.waitForSelector('.allsessions', { timeout: 15_000 })

  // register a local project, then launch a labeled product session via IPC
  const projectId = await win.evaluate(async (p) => {
    const project = await window.agentIDE.projectsAddLocal(p)
    return project.id
  }, proj)

  const launched = await win.evaluate(
    async ({ projectId, cwd }) => {
      try {
        const s = await window.agentIDE.sessionLaunch({
          projectId,
          provider: 'claude',
          model: 'claude-opus-4-8',
          objective: 'ship the widget',
          cwd,
          useContainer: false,
          taskKind: 'product',
          taskSubkind: 'feature'
        })
        return { id: s.id, taskKind: s.taskKind, taskSubkind: s.taskSubkind, taskStatus: s.taskStatus }
      } catch (e) {
        return { error: String(e) }
      }
    },
    { projectId, cwd: proj }
  )

  // the session was created and carries its label (even if the CLI spawn had no
  // output, the row + label persist)
  expect(launched.error).toBeUndefined()
  expect(launched.taskKind).toBe('product')
  expect(launched.taskSubkind).toBe('feature')
  expect(launched.taskStatus).toBe('open')

  // an UNLABELED agent launch is rejected by the main-side validator (M-LOG-a)
  const unlabeled = await win.evaluate(
    async ({ projectId, cwd }) => {
      try {
        await window.agentIDE.sessionLaunch({
          projectId,
          provider: 'claude',
          model: 'claude-opus-4-8',
          objective: 'x',
          cwd,
          useContainer: false
        } as any)
        return 'accepted'
      } catch (e) {
        return 'rejected'
      }
    },
    { projectId, cwd: proj }
  )
  expect(unlabeled).toBe('rejected')

  // mark finished → main writes the raw log entry for this product task
  const res = await win.evaluate((id) => window.agentIDE.taskSetStatus(id, 'finished'), launched.id!)
  expect(res.error).toBeUndefined()

  const logPath = join(projectsDir, projectId, 'log', 'raw', `${launched.id}.md`)
  expect(existsSync(logPath)).toBe(true)
  const body = readFileSync(logPath, 'utf8')
  expect(body).toContain('task_kind: product')
  expect(body).toContain('task_subkind: feature')

  // M-LOG-b §4.6-16: ticket generation is crash-safe. With a FAILING runner the
  // session must STAY 'deployed' (not corrupted), with the error surfaced for
  // retry — never advanced to 'ticketed'.
  const ticket = await win.evaluate((id) => window.agentIDE.taskGenerateTicket(id), launched.id!)
  expect(ticket.error).toBeTruthy() // failing runner → clean failure
  expect(ticket.ok).toBeUndefined()
  const after = await win.evaluate(async (pid) => {
    const s = (await window.agentIDE.sessionsAll()).find(
      (x: any) => x.projectId === pid && x.taskKind === 'product'
    )
    return s?.taskStatus
  }, projectId)
  expect(after).toBe('deployed') // stayed deployed — retry available

  await app.close()
})

// B1: with a WORKING runner the deployed→ticketed pass completes: validated
// fields, a deterministic ticket file, the row + status advanced atomically,
// and a repeat call returning the existing ticket (idempotent).
test('ticket generation succeeds end-to-end with a working runner', async () => {
  const base = mkdtempSync(join(tmpdir(), 'agide-ticket-ok-'))
  const dbPath = join(base, 'store.sqlite')
  const projectsDir = join(base, 'projects')
  const proj = mkdtempSync(join(tmpdir(), 'agide-proj-'))

  const app = await electron.launch({
    args: electronArgs(),
    env: {
      ...process.env,
      AGENT_IDE_DB: dbPath,
      AGENT_IDE_PROJECTS: projectsDir,
      AGENT_IDE_TICKET_CMD: JSON.stringify(['node', join(__dirname, 'fixtures', 'ticket-ok.js')])
    }
  })
  const win = await app.firstWindow()
  await win.waitForSelector('.allsessions', { timeout: 15_000 })

  const projectId = await win.evaluate(async (p) => (await window.agentIDE.projectsAddLocal(p)).id, proj)
  const launched = await win.evaluate(
    async ({ projectId, cwd }) => {
      const s = await window.agentIDE.sessionLaunch({
        projectId,
        provider: 'claude',
        model: 'claude-opus-4-8',
        objective: 'ship the widget',
        cwd,
        useContainer: false,
        taskKind: 'product',
        taskSubkind: 'feature'
      })
      return { id: s.id }
    },
    { projectId, cwd: proj }
  )

  await win.evaluate((id) => window.agentIDE.taskSetStatus(id, 'finished'), launched.id)
  const ticket = await win.evaluate((id) => window.agentIDE.taskGenerateTicket(id), launched.id)
  expect(ticket.error).toBeUndefined()
  expect(ticket.ok).toBe(true)
  expect(ticket.ticketId).toBe(`ticket-${launched.id}`)
  expect(ticket.ticketPath).toBeTruthy()
  expect(existsSync(ticket.ticketPath!)).toBe(true)
  expect(readFileSync(ticket.ticketPath!, 'utf8')).toContain('# Fixture ticket')

  const after = await win.evaluate(
    async (id) => (await window.agentIDE.sessionsAll()).find((x: any) => x.id === id)?.taskStatus,
    launched.id
  )
  expect(after).toBe('ticketed')

  // Idempotent: a second call returns the existing ticket, no regeneration.
  const again = await win.evaluate((id) => window.agentIDE.taskGenerateTicket(id), launched.id)
  expect(again.ok).toBe(true)
  expect(again.ticketId).toBe(`ticket-${launched.id}`)

  await app.close()
})
