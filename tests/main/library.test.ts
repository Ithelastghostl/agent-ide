import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseFrontmatter,
  parseWorkflowMeta,
  scanLibrary,
  readLibraryItem,
  addAgent,
  agentSlug
} from '../../src/main/library'
import { readFileSync } from 'node:fs'
import YAML from 'yaml'

describe('parseFrontmatter', () => {
  it('parses simple key: value frontmatter and returns the body', () => {
    const { meta, body } = parseFrontmatter(
      '---\nname: my-skill\ndescription: does a thing\n---\n# Title\nbody text'
    )
    expect(meta.name).toBe('my-skill')
    expect(meta.description).toBe('does a thing')
    expect(body).toContain('# Title')
    expect(body).toContain('body text')
  })
  it('strips surrounding quotes', () => {
    expect(parseFrontmatter('---\nname: "quoted"\n---\nx').meta.name).toBe('quoted')
  })
  it('parses a multiline block scalar (description: |)', () => {
    const { meta } = parseFrontmatter('---\nname: s\ndescription: |\n  line one\n  line two\n---\nbody')
    expect(meta.name).toBe('s')
    expect(meta.description).toBe('line one line two')
  })
  it('returns empty meta + original text when no frontmatter', () => {
    const { meta, body } = parseFrontmatter('# Just markdown\nno frontmatter')
    expect(meta).toEqual({})
    expect(body).toBe('# Just markdown\nno frontmatter')
  })
})

describe('parseWorkflowMeta', () => {
  it('extracts name + description from export const meta', () => {
    const src =
      "export const meta = {\n  name: 'review-changes',\n  description: 'review the diff',\n  phases: []\n}\n"
    expect(parseWorkflowMeta(src)).toEqual({ name: 'review-changes', description: 'review the diff' })
  })
  it('returns {} when absent', () => {
    expect(parseWorkflowMeta('const x = 1')).toEqual({})
  })
})

describe('scanLibrary', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agide-lib-'))
    // a skill (dir + SKILL.md)
    mkdirSync(join(dir, 'skills', 'debug-it'), { recursive: true })
    writeFileSync(
      join(dir, 'skills', 'debug-it', 'SKILL.md'),
      '---\nname: debug-it\ndescription: systematic debugging\n---\n# Debug it\n'
    )
    // a skill dir WITHOUT SKILL.md (should be ignored)
    mkdirSync(join(dir, 'skills', 'empty'), { recursive: true })
    // a prompt
    mkdirSync(join(dir, 'prompts'), { recursive: true })
    writeFileSync(
      join(dir, 'prompts', 'tidy.md'),
      '---\ndescription: tidy the code\n---\nPlease tidy this code.'
    )
    // a prompt with no frontmatter (name from filename, desc from heading)
    writeFileSync(join(dir, 'prompts', 'explain.md'), '# Explain this\nWalk me through it.')
    // a workflow
    mkdirSync(join(dir, 'workflows'), { recursive: true })
    writeFileSync(
      join(dir, 'workflows', 'audit.js'),
      "export const meta = { name: 'audit', description: 'audit pass', phases: [] }\n"
    )
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('finds skills with a SKILL.md and skips dirs without one', () => {
    const lib = scanLibrary(dir)
    expect(lib.skills).toHaveLength(1)
    expect(lib.skills[0]).toMatchObject({
      category: 'skills',
      name: 'debug-it',
      description: 'systematic debugging',
      relPath: 'skills/debug-it/SKILL.md'
    })
  })
  it('finds prompts; name/description from frontmatter or fallbacks', () => {
    const lib = scanLibrary(dir)
    expect(lib.prompts.map((p) => p.name).sort()).toEqual(['explain', 'tidy'])
    const explain = lib.prompts.find((p) => p.name === 'explain')!
    expect(explain.description).toBe('Explain this') // first heading fallback
    const tidy = lib.prompts.find((p) => p.name === 'tidy')!
    expect(tidy.description).toBe('tidy the code')
  })
  it('finds workflows via export const meta', () => {
    const lib = scanLibrary(dir)
    expect(lib.workflows).toHaveLength(1)
    expect(lib.workflows[0]).toMatchObject({
      name: 'audit',
      description: 'audit pass',
      relPath: 'workflows/audit.js'
    })
  })
  it('returns empty arrays for a library with no category folders', () => {
    const empty = mkdtempSync(join(tmpdir(), 'agide-lib-empty-'))
    expect(scanLibrary(empty)).toEqual({ prompts: [], skills: [], workflows: [], agents: [] })
    rmSync(empty, { recursive: true, force: true })
  })
})

// L1: library:read (readLibraryItem) is confined to the library root via the same
// symlink-hardened confinedPath as B1/B2 — the library repo is a clone of an
// external repo, so a malicious symlink inside it must not escape to host files.
describe('readLibraryItem confinement (L1, shares B1/B2 hardening)', () => {
  let base: string
  let lib: string
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'agide-libread-'))
    lib = join(base, 'library')
    mkdirSync(join(lib, 'prompts'), { recursive: true })
    writeFileSync(join(lib, 'prompts', 'ok.md'), 'safe content')
    process.env.AGENT_IDE_LIBRARY = lib
  })
  afterEach(() => {
    delete process.env.AGENT_IDE_LIBRARY
    rmSync(base, { recursive: true, force: true })
  })

  it('reads an item inside the library', () => {
    expect(readLibraryItem('prompts/ok.md')).toEqual({ content: 'safe content' })
  })

  it('rejects a lexical escape (..)', () => {
    writeFileSync(join(base, 'secret.txt'), 'top secret')
    expect(readLibraryItem('../secret.txt').error).toBeTruthy()
    expect(readLibraryItem('../secret.txt').content).toBeUndefined()
  })

  it('rejects a symlink inside the library that points outside it (B2 hardening)', () => {
    const outside = join(base, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 'top secret')
    symlinkSync(outside, join(lib, 'escape')) // library/escape -> ../outside
    const res = readLibraryItem('escape/secret.txt')
    expect(res.content).toBeUndefined()
    expect(res.error).toBeTruthy()
  })
})

// B2: the agents category — one .md file with JSON-quoted (valid YAML) meta and
// layered body sections, created through addAgent with strict validation.
describe('agents (B2)', () => {
  let lib: string
  beforeEach(() => {
    lib = mkdtempSync(join(tmpdir(), 'agide-lib-agents-'))
  })
  afterEach(() => {
    rmSync(lib, { recursive: true, force: true })
  })

  it('agentSlug derives a filesystem slug', () => {
    expect(agentSlug('Release Notes Writer')).toBe('release-notes-writer')
    expect(agentSlug('  ⚡️ Fancy!! Agent  ')).toBe('fancy-agent')
    expect(agentSlug('日本語')).toBe('') // no ascii alnum → invalid
  })

  it('addAgent writes agents/<slug>.md and scanLibrary reads it back verbatim', () => {
    const input = {
      name: 'Fix: the "auth" #1 agent',
      description: 'Handles auth: bugs #fast, with "quotes" and \\backslashes\\',
      instructions: 'Do the thing.\nCarefully.',
      data: 'endpoint: https://api.example.com',
      context: 'Used by the TalentChain project.'
    }
    const r = addAgent(input, lib)
    expect(r.error).toBeUndefined()
    expect(r.relPath).toBe('agents/fix-the-auth-1-agent.md')

    const scanned = scanLibrary(lib).agents
    expect(scanned).toHaveLength(1)
    // Round-trip: name/description survive quotes, colons, '#', backslashes.
    expect(scanned[0].name).toBe(input.name)
    expect(scanned[0].description).toBe(input.description)

    const text = readFileSync(join(lib, r.relPath!), 'utf8')
    expect(text).toContain('# Instructions')
    expect(text).toContain('Do the thing.')
    expect(text).toContain('# Data')
    expect(text).toContain('endpoint: https://api.example.com')
    expect(text).toContain('# Context')

    // The frontmatter must be VALID YAML for conforming parsers, not just ours.
    const fmBlock = /^---\n([\s\S]*?)\n---\n/.exec(text)![1]
    const parsed = YAML.parse(fmBlock) as { name: string; description: string }
    expect(parsed.name).toBe(input.name)
    expect(parsed.description).toBe(input.description)
  })

  it('refuses a duplicate slug (exclusive write, never overwrite)', () => {
    expect(
      addAgent({ name: 'My Agent', description: '', instructions: 'v1', data: '', context: '' }, lib).relPath
    ).toBeTruthy()
    const dup = addAgent(
      { name: 'my   AGENT', description: '', instructions: 'v2', data: '', context: '' },
      lib
    )
    expect(dup.error).toMatch(/already exists/)
    expect(readFileSync(join(lib, 'agents', 'my-agent.md'), 'utf8')).toContain('v1') // untouched
  })

  it('validates name, description, and layer sizes at the boundary', () => {
    expect(
      addAgent({ name: '', description: '', instructions: '', data: '', context: '' }, lib).error
    ).toMatch(/name/)
    expect(
      addAgent({ name: '!!!', description: '', instructions: '', data: '', context: '' }, lib).error
    ).toMatch(/letter or digit/)
    expect(
      addAgent({ name: 'x'.repeat(81), description: '', instructions: '', data: '', context: '' }, lib).error
    ).toMatch(/1–80/)
    expect(
      addAgent({ name: 'ok', description: 'two\nlines', instructions: '', data: '', context: '' }, lib).error
    ).toMatch(/single line/)
    expect(
      addAgent(
        { name: 'ok', description: '', instructions: 'x'.repeat(64 * 1024 + 1), data: '', context: '' },
        lib
      ).error
    ).toMatch(/exceeds/)
  })

  it('agents count toward the library scan without disturbing other categories', () => {
    addAgent({ name: 'a1', description: 'first', instructions: '', data: '', context: '' }, lib)
    addAgent({ name: 'a2', description: 'second', instructions: '', data: '', context: '' }, lib)
    const all = scanLibrary(lib)
    expect(all.agents.map((a) => a.name)).toEqual(['a1', 'a2'])
    expect(all.prompts).toEqual([])
  })
})
