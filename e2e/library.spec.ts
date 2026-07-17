import { test, expect, _electron as electron } from '@playwright/test'
import { electronArgs } from './launch'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// The Library (D14): cockpit pills show real counts from a GitHub-backed library
// folder; clicking a pill opens a filterable list; inserting a prompt writes its
// body into the active session's pty. Observed via the session history file.
test('library pills show counts and inserting a prompt writes it to the active session', async () => {
  const proj = mkdtempSync(join(tmpdir(), 'agide-proj-'))
  mkdirSync(join(proj, 'src')); writeFileSync(join(proj, 'README.md'), '# x\n')
  const dbPath = join(mkdtempSync(join(tmpdir(), 'agide-db-')), 'store.sqlite')
  const histDir = mkdtempSync(join(tmpdir(), 'agide-hist-'))

  // Seed a library folder: 2 prompts, 1 skill, 1 workflow.
  const libDir = mkdtempSync(join(tmpdir(), 'agide-lib-'))
  mkdirSync(join(libDir, 'prompts'), { recursive: true })
  writeFileSync(join(libDir, 'prompts', 'refactor.md'), '---\ndescription: refactor helper\n---\nPLEASE_REFACTOR_THIS_CODE')
  writeFileSync(join(libDir, 'prompts', 'explain.md'), '# Explain\nwalk me through it')
  mkdirSync(join(libDir, 'skills', 'debug-it'), { recursive: true })
  writeFileSync(join(libDir, 'skills', 'debug-it', 'SKILL.md'), '---\nname: debug-it\ndescription: debugging\n---\n# Debug\n')
  mkdirSync(join(libDir, 'workflows'), { recursive: true })
  writeFileSync(join(libDir, 'workflows', 'audit.js'), "export const meta = { name: 'audit', description: 'audit', phases: [] }\n")
  mkdirSync(join(libDir, 'agents'), { recursive: true })
  writeFileSync(join(libDir, 'agents', 'helper.md'), '---\nname: "helper"\ndescription: "a seeded agent"\n---\n# Instructions\nhelp\n# Data\n\n# Context\n\n')

  const app = await electron.launch({
    args: electronArgs(),
    env: { ...process.env, AGENT_IDE_DB: dbPath, AGENT_IDE_HISTORY: histDir, AGENT_IDE_LIBRARY: libDir }
  })
  const win = await app.firstWindow()
  await win.waitForSelector('.projrail', { timeout: 20_000 })
  await win.evaluate(async (p) => { await window.agentIDE.projectsAddLocal(p) }, proj)
  await expect.poll(async () => (await win.evaluate(() => window.agentIDE.projectsList())).length, { timeout: 15_000 }).toBeGreaterThan(0)
  await win.reload()
  await win.locator('.projrail .pj').first().click({ timeout: 20_000 })

  // Pills show real counts (Prompts 2 · Skills 1 · Flows 1 · Agents 1).
  await expect.poll(async () => win.evaluate(() => {
    const pills = Array.from(document.querySelectorAll('.libpills .pill')).map((p) => p.textContent || '')
    return pills.join(' | ')
  }), { timeout: 10_000 }).toContain('Prompts2')
  await expect.poll(async () => win.evaluate(() => {
    const pills = Array.from(document.querySelectorAll('.libpills .pill')).map((p) => p.textContent || '')
    return pills.join(' | ')
  }), { timeout: 10_000 }).toContain('Agents1')

  // B2: adding an agent through the bridge lands in the library scan (and the
  // duplicate is refused, never overwritten).
  const added = await win.evaluate(() => window.agentIDE.libraryAddAgent({
    name: 'Release Writer', description: 'writes release notes',
    instructions: 'Write terse notes.', data: 'style: terse', context: 'for the IDE repo'
  }))
  expect(added.error).toBeUndefined()
  expect(added.relPath).toBe('agents/release-writer.md')
  const dup = await win.evaluate(() => window.agentIDE.libraryAddAgent({
    name: 'release   writer', description: '', instructions: '', data: '', context: ''
  }))
  expect(dup.error).toContain('already exists')
  const agentNames = await win.evaluate(async () => (await window.agentIDE.libraryList()).agents.map((a: any) => a.name))
  expect(agentNames.sort()).toEqual(['Release Writer', 'helper'])

  // Open a session so "insert" has a live pty to write into.
  await win.locator('.provrow.terminal .add').click({ timeout: 20_000 })
  await win.waitForSelector('.terminal-host .xterm', { timeout: 15_000 })
  const id = await win.evaluate(async () => {
    const s = (await window.agentIDE.sessionsAll()).filter((x: any) => x.id.startsWith('term-')).pop()
    return s?.id
  })

  // Click the Prompts pill → panel opens → filter → insert 'refactor'.
  await win.locator('.libpills .pill', { hasText: 'Prompts' }).click()
  await win.waitForSelector('.modal .lib-search', { timeout: 8_000 })
  await win.locator('.modal .lib-search').fill('refactor')
  await expect(win.locator('.modal .mopt')).toHaveCount(1) // filtered to one
  await win.locator('.modal .mopt .lib-use').click()

  // The prompt BODY (frontmatter stripped) should reach the session's pty.
  const file = join(histDir, `${id}.log`)
  await expect.poll(() => (existsSync(file) ? readFileSync(file, 'utf8') : ''), { timeout: 6_000 })
    .toContain('PLEASE_REFACTOR_THIS_CODE')

  await app.close()
})
