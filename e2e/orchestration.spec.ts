import { test, expect, _electron as electron } from '@playwright/test'
import { electronArgs, e2eEnv } from './launch'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// S6 orchestration end-to-end (real Electron main, host sessions only, provider
// shims on PATH so no real CLI is ever reached — R3-4/R6-2). Driven through the
// IPC bridge like the other v2 specs. Temp dirs for DB / projects / history /
// queue-flag so the run is hermetic and never touches the user's real store.
function boot() {
  const base = mkdtempSync(join(tmpdir(), 'agide-orch-'))
  const proj = mkdtempSync(join(tmpdir(), 'agide-orch-proj-'))
  const app = electron.launch({
    args: electronArgs(),
    env: e2eEnv({
      AGENT_IDE_DB: join(base, 'store.sqlite'),
      AGENT_IDE_PROJECTS: join(base, 'projects'),
      AGENT_IDE_HISTORY: join(base, 'history'),
      AGENT_IDE_QUEUE: join(base, 'queue')
    })
  })
  return { app, proj }
}

// A queued session's pty is spawned through the provider shim (host). Poll until
// the queue row reaches 'launched' (advancement is gated + async).
async function waitForLaunched(win: any, projectId: string, count: number) {
  await expect.poll(async () =>
    (await win.evaluate((pid: string) => window.agentIDE.queueList(pid), projectId))
      .filter((q: any) => q.state === 'launched').length,
    { timeout: 15_000 }
  ).toBe(count)
}

test('autoAdvance: archiving the first queued session launches the second', async () => {
  const { app: appP, proj } = boot()
  const app = await appP
  const win = await app.firstWindow()
  await win.waitForSelector('.allsessions', { timeout: 15_000 })

  const projectId = await win.evaluate((p) => window.agentIDE.projectsAddLocal(p).then((x) => x.id), proj)

  // Enable autoAdvance, then enqueue two host provider sessions.
  await win.evaluate((pid) => window.agentIDE.queueSetAutoAdvance(pid, true), projectId)
  await win.evaluate(async ({ pid }) => {
    await window.agentIDE.queueEnqueue({ projectId: pid, provider: 'claude', model: 'claude-opus-4-8', objective: 'first', useContainer: false })
    await window.agentIDE.queueEnqueue({ projectId: pid, provider: 'claude', model: 'claude-opus-4-8', objective: 'second', useContainer: false })
  }, { pid: projectId })

  // Enqueue into an autoAdvance project auto-launches the FIRST (R21/R23-minor).
  await waitForLaunched(win, projectId, 1)

  // Find the launched session for item 1 and archive it → the 'archived' event
  // fires and (autoAdvance on) the SECOND item launches.
  const firstSessionId = await win.evaluate((pid) =>
    window.agentIDE.queueList(pid).then((qs) => qs.find((q: any) => q.state === 'launched')?.launchedSessionId ?? ''),
    projectId)
  expect(firstSessionId).toBeTruthy()

  await win.evaluate((id) => window.agentIDE.sessionArchive(id), firstSessionId)

  // Now BOTH items are launched (the archive triggered advancement of the second).
  await waitForLaunched(win, projectId, 2)

  await app.close()
})

test('split view renders two terminal hosts', async () => {
  const { app: appP, proj } = boot()
  const app = await appP
  const win = await app.firstWindow()
  await win.waitForSelector('.allsessions', { timeout: 15_000 })

  const projectId = await win.evaluate((p) => window.agentIDE.projectsAddLocal(p).then((x) => x.id), proj)
  await expect.poll(async () =>
    win.evaluate((pid) => window.agentIDE.projectsList().then((ps) => ps.some((x) => x.id === pid)), projectId),
    { timeout: 10_000 }
  ).toBe(true)

  // Launch two host terminal sessions so both panes have a live pty to mount.
  const ids = await win.evaluate(async ({ pid, cwd }) => {
    const a = await window.agentIDE.terminalOpen({ projectId: pid, cwd, name: 'A', useContainer: false })
    const b = await window.agentIDE.terminalOpen({ projectId: pid, cwd, name: 'B', useContainer: false })
    return [a.id, b.id]
  }, { pid: projectId, cwd: proj })
  expect(ids.length).toBe(2)

  // Reload so the renderer hydrates the persisted project + the two live-pty
  // sessions (boot's ptyAlive check attaches them), then drive the UI: open the
  // project cockpit, focus a session, and toggle split view.
  await win.reload()
  await win.waitForSelector('.projrail .pj', { timeout: 15_000 })
  await win.locator('.projrail .pj').first().click()
  // Focus a session so the session tab (and its split control) render.
  await win.waitForSelector('.cockpit .scard', { timeout: 15_000 })
  await win.locator('.cockpit .scard').first().click()

  // Toggle split view via the tab-strip control.
  await win.waitForSelector('.ed-split', { timeout: 15_000 })
  await win.locator('.ed-split').click()

  // Two session panes, each with a terminal host mounted (SessionTerminal).
  await expect(win.locator('.sv-split .sv-pane')).toHaveCount(2)
  await expect(win.locator('.sv-split .terminal-host')).toHaveCount(2)

  await app.close()
})

test('handoff registers pending review on B and does NOT write it to B until "Review & insert"', async () => {
  const { app: appP, proj } = boot()
  const app = await appP
  const win = await app.firstWindow()
  await win.waitForSelector('.allsessions', { timeout: 15_000 })

  const projectId = await win.evaluate((p) => window.agentIDE.projectsAddLocal(p).then((x) => x.id), proj)
  // Ensure the project row is committed + visible before launching against it
  // (the add is async; session:launch validates ownership against the store).
  await expect.poll(async () =>
    win.evaluate((pid) => window.agentIDE.projectsList().then((ps) => ps.some((x) => x.id === pid)), projectId),
    { timeout: 10_000 }
  ).toBe(true)

  // Two host provider sessions (A, B) via the shims.
  const { aId, bId } = await win.evaluate(async ({ pid, cwd }) => {
    const a = await window.agentIDE.sessionLaunch({ projectId: pid, provider: 'claude', model: 'claude-opus-4-8', objective: 'source A', cwd, useContainer: false, taskKind: 'analysis' })
    const b = await window.agentIDE.sessionLaunch({ projectId: pid, provider: 'claude', model: 'claude-opus-4-8', objective: 'target B', cwd, useContainer: false, taskKind: 'analysis' })
    return { aId: a.id, bId: b.id }
  }, { pid: projectId, cwd: proj })

  // Give A some transcript to hand off (the shim echoes stdin). Write repeatedly
  // until the echo lands, so the tail isn't empty (echo timing varies).
  await expect.poll(async () =>
    win.evaluate(async (id) => {
      window.agentIDE.ptyWrite(id, 'context line from A\n')
      return (await window.agentIDE.transcriptGet(id)).trim().length
    }, aId),
    { timeout: 15_000, intervals: [250, 250, 500, 1000] }
  ).toBeGreaterThan(0)

  // Hand A → B. This must register pending review on B, writing NOTHING to B's pty.
  const res = await win.evaluate(({ a, b }) => window.agentIDE.sessionHandoff(a, b), { a: aId, b: bId })
  expect(res.error).toBeUndefined()
  expect(res.ok).toBe(true)

  // B now has pending review material.
  const pending = await win.evaluate((id) => window.agentIDE.reviewPending(id), bId)
  expect(pending.sections.length).toBeGreaterThanOrEqual(1)
  expect(pending.totalChars).toBeGreaterThan(0)

  // CRITICAL: the handoff wrote NOTHING to B's pty — B's transcript must not carry
  // the handed-off text before the user explicitly inserts it.
  const bBefore = await win.evaluate((id) => window.agentIDE.transcriptGet(id), bId)
  expect(bBefore).not.toContain('context line from A')

  // Insert it: this bracket-pastes into B (no trailing newline). The bracketed
  // paste markers land in B's transcript (the echo of what was pasted), proving
  // the review material was delivered as a paste and never auto-submitted.
  const ins = await win.evaluate((id) => window.agentIDE.reviewInsert(id), bId)
  expect(ins.error).toBeUndefined()
  expect(ins.ok).toBe(true)

  // After insert the pending set is empty (it was consumed).
  const after = await win.evaluate((id) => window.agentIDE.reviewPending(id), bId)
  expect(after.totalChars).toBe(0)

  // The pasted material now appears in B's transcript wrapped in bracketed-paste
  // markers (the shim echoes stdin), and NOT before the insert.
  await expect.poll(async () => win.evaluate((id) => window.agentIDE.transcriptGet(id), bId), { timeout: 10_000 })
    .toContain('context line from A')

  await app.close()
})
