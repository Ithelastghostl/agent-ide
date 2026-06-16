import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseFrontmatter, parseWorkflowMeta, scanLibrary } from '../../src/main/library'

describe('parseFrontmatter', () => {
  it('parses simple key: value frontmatter and returns the body', () => {
    const { meta, body } = parseFrontmatter('---\nname: my-skill\ndescription: does a thing\n---\n# Title\nbody text')
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
    const src = "export const meta = {\n  name: 'review-changes',\n  description: 'review the diff',\n  phases: []\n}\n"
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
    writeFileSync(join(dir, 'skills', 'debug-it', 'SKILL.md'), '---\nname: debug-it\ndescription: systematic debugging\n---\n# Debug it\n')
    // a skill dir WITHOUT SKILL.md (should be ignored)
    mkdirSync(join(dir, 'skills', 'empty'), { recursive: true })
    // a prompt
    mkdirSync(join(dir, 'prompts'), { recursive: true })
    writeFileSync(join(dir, 'prompts', 'tidy.md'), '---\ndescription: tidy the code\n---\nPlease tidy this code.')
    // a prompt with no frontmatter (name from filename, desc from heading)
    writeFileSync(join(dir, 'prompts', 'explain.md'), '# Explain this\nWalk me through it.')
    // a workflow
    mkdirSync(join(dir, 'workflows'), { recursive: true })
    writeFileSync(join(dir, 'workflows', 'audit.js'), "export const meta = { name: 'audit', description: 'audit pass', phases: [] }\n")
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('finds skills with a SKILL.md and skips dirs without one', () => {
    const lib = scanLibrary(dir)
    expect(lib.skills).toHaveLength(1)
    expect(lib.skills[0]).toMatchObject({ category: 'skills', name: 'debug-it', description: 'systematic debugging', relPath: 'skills/debug-it/SKILL.md' })
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
    expect(lib.workflows[0]).toMatchObject({ name: 'audit', description: 'audit pass', relPath: 'workflows/audit.js' })
  })
  it('returns empty arrays for a library with no category folders', () => {
    const empty = mkdtempSync(join(tmpdir(), 'agide-lib-empty-'))
    expect(scanLibrary(empty)).toEqual({ prompts: [], skills: [], workflows: [] })
    rmSync(empty, { recursive: true, force: true })
  })
})
