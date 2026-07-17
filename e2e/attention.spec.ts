import { test, expect, _electron as electron } from '@playwright/test'
import { electronArgs, e2eEnv } from './launch'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// S5 attention/cost — real Electron main, via the IPC bridge (e2eEnv + temp dirs).
//
// The attention monitor and cost parser subscribe to the sessionEvents 'output'
// bus (the frozen P0.A contract). This spec exercises the monitor's registrar
// wiring in the real app: the attention:state and cost:forSession IPC contracts
// answer correctly, and a live provider session (inert shim) is tracked.
test('attention + cost IPC contracts answer through the real bridge', async () => {
  const proj = mkdtempSync(join(tmpdir(), 'agide-att-proj-'))
  mkdirSync(join(proj, 'src')); writeFileSync(join(proj, 'README.md'), '# x\n')
  const dbPath = join(mkdtempSync(join(tmpdir(), 'agide-att-db-')), 'store.sqlite')
  const histDir = mkdtempSync(join(tmpdir(), 'agide-att-hist-'))

  const app = await electron.launch({
    args: electronArgs(),
    // Short quiet window so a bus-driven flag would land fast (used by the
    // fixme'd end-to-end test below once the foundation routes output to the bus).
    env: e2eEnv({ AGENT_IDE_DB: dbPath, AGENT_IDE_HISTORY: histDir, AGENT_IDE_ATTENTION_QUIET_MS: '600' })
  })
  const win = await app.firstWindow()
  await win.waitForSelector('.projrail', { timeout: 20_000 })
  const projectId = await win.evaluate(async (p) => (await window.agentIDE.projectsAddLocal(p)).id, proj)

  // Launch a provider session (the inert shim — no real CLI, e2eEnv guards PATH).
  const sessionId = await win.evaluate(async ({ projectId, cwd }) => {
    const s = await window.agentIDE.sessionLaunch({
      projectId, provider: 'claude', model: 'claude-opus-4-8',
      objective: 'attention probe', cwd, useContainer: false, taskKind: 'analysis'
    })
    return s.id
  }, { projectId, cwd: proj })

  // attention:state is a well-formed (empty until something is flagged) map.
  const state = await win.evaluate(() => window.agentIDE.attentionState())
  expect(typeof state).toBe('object')

  // cost:forSession returns "unknown" (never $0) when no summary has been parsed.
  const cost = await win.evaluate((id) => window.agentIDE.costForSession(id), sessionId)
  expect(cost).toEqual({ error: 'unknown' })

  await app.close()
})

// End-to-end badge behaviour: drive a session, let it go quiet on a question-like
// line, and assert the session is flagged 'input' after the (short, injected)
// quiet window — surfaced on both the main attention:state and the renderer badge
// event. ipc.ts recordOutput now emits on the sessionEvents 'output' bus, so the
// monitor receives real output end-to-end.
test('a quiet session ending on a question is flagged as needing input', async () => {
  const proj = mkdtempSync(join(tmpdir(), 'agide-att2-proj-'))
  mkdirSync(join(proj, 'src')); writeFileSync(join(proj, 'README.md'), '# x\n')
  const dbPath = join(mkdtempSync(join(tmpdir(), 'agide-att2-db-')), 'store.sqlite')
  const histDir = mkdtempSync(join(tmpdir(), 'agide-att2-hist-'))

  const app = await electron.launch({
    args: electronArgs(),
    env: e2eEnv({ AGENT_IDE_DB: dbPath, AGENT_IDE_HISTORY: histDir, AGENT_IDE_ATTENTION_QUIET_MS: '600' })
  })
  const win = await app.firstWindow()
  await win.waitForSelector('.projrail', { timeout: 20_000 })
  const projectId = await win.evaluate(async (p) => (await window.agentIDE.projectsAddLocal(p)).id, proj)

  await win.evaluate(() => {
    ;(window as unknown as { __att: Record<string, string | null> }).__att = {}
    window.agentIDE.onAttention(({ sessionId, state }) => {
      ;(window as unknown as { __att: Record<string, string | null> }).__att[sessionId] = state
    })
  })

  const sessionId = await win.evaluate(async ({ projectId, cwd }) => {
    const s = await window.agentIDE.sessionLaunch({
      projectId, provider: 'claude', model: 'claude-opus-4-8',
      objective: 'attention probe', cwd, useContainer: false, taskKind: 'analysis'
    })
    return s.id
  }, { projectId, cwd: proj })

  // Wait for the shim banner, then feed a question-like line as the last output.
  await expect.poll(() => win.evaluate((id) => window.agentIDE.transcriptGet(id), sessionId), { timeout: 10_000 })
    .toContain('SHIM_PROVIDER_READY')
  await win.evaluate((id) => window.agentIDE.ptyWrite(id, 'Do you want to proceed?\r'), sessionId)

  await expect.poll(
    () => win.evaluate((id) => window.agentIDE.attentionState().then((m) => m[id] ?? null), sessionId),
    { timeout: 10_000 }
  ).toBe('input')
  await expect.poll(
    () => win.evaluate((id) => (window as unknown as { __att: Record<string, string | null> }).__att[id] ?? null, sessionId),
    { timeout: 5_000 }
  ).toBe('input')

  // Answering (pty:write) clears the flag.
  await win.evaluate((id) => window.agentIDE.ptyWrite(id, 'y\r'), sessionId)
  await expect.poll(
    () => win.evaluate((id) => window.agentIDE.attentionState().then((m) => m[id] ?? null), sessionId),
    { timeout: 5_000 }
  ).toBe(null)

  await app.close()
})
