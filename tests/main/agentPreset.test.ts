import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  composeLaunchPrimer, agentBodyForPrimer, isRegisteredAgent, stripAgentFrontmatter
} from '../../src/main/agentPreset'
import { validateLaunchRequest } from '../../src/main/validate'

// S8 + R7 + P0.D: an agent preset launch validates the relPath (confined +
// registered) and primes the agent BODY after the harness section.

const AGENT_MD = [
  '---',
  'name: "Release Writer"',
  'description: "writes terse release notes"',
  '---',
  '# Instructions',
  'AGENT_BODY_MARKER: write terse notes.',
  '# Data',
  'style: terse',
  '# Context',
  'for the IDE repo'
].join('\n')

describe('S8 agentPreset — registration + primer', () => {
  let libDir: string
  let harnessDir: string

  beforeEach(() => {
    libDir = mkdtempSync(join(tmpdir(), 'agide-lib-'))
    mkdirSync(join(libDir, 'agents'), { recursive: true })
    writeFileSync(join(libDir, 'agents', 'release-writer.md'), AGENT_MD)
    process.env.AGENT_IDE_LIBRARY = libDir
    harnessDir = mkdtempSync(join(tmpdir(), 'agide-harness-'))
    process.env.AGENT_IDE_HARNESS = harnessDir
  })
  afterEach(() => {
    delete process.env.AGENT_IDE_LIBRARY
    delete process.env.AGENT_IDE_HARNESS
    rmSync(libDir, { recursive: true, force: true })
    rmSync(harnessDir, { recursive: true, force: true })
  })

  it('stripAgentFrontmatter drops the YAML block, keeps the body', () => {
    const body = stripAgentFrontmatter(AGENT_MD)
    expect(body).not.toContain('name:')
    expect(body).toContain('AGENT_BODY_MARKER')
  })

  it('isRegisteredAgent accepts a scanned agent, rejects unknown/traversal paths', () => {
    expect(isRegisteredAgent('agents/release-writer.md')).toBe(true)
    expect(isRegisteredAgent('agents/does-not-exist.md')).toBe(false)
    expect(isRegisteredAgent('../../etc/passwd')).toBe(false)
    expect(isRegisteredAgent('prompts/release-writer.md')).toBe(false) // not an agent
  })

  it('agentBodyForPrimer returns the frontmatter-stripped body for a registered agent', () => {
    expect(agentBodyForPrimer('agents/release-writer.md')).toContain('AGENT_BODY_MARKER')
    expect(agentBodyForPrimer('agents/nope.md')).toBe('') // unregistered → no primer
    expect(agentBodyForPrimer(null)).toBe('')
  })

  it('composeLaunchPrimer places the agent body AFTER the harness section, fenced + trusted', () => {
    const primer = composeLaunchPrimer({
      objective: 'ship the notes',
      agentRelPath: 'agents/release-writer.md',
      agentLabel: 'Release Writer'
    })
    // all three sections present
    expect(primer).toContain('BEGIN HARNESS')
    expect(primer).toContain('BEGIN AGENT: Release Writer')
    expect(primer).toContain('AGENT_BODY_MARKER')
    expect(primer).toContain('BEGIN OBJECTIVE')
    expect(primer).toContain('ship the notes')
    // ordering: harness → agent → objective
    expect(primer.indexOf('BEGIN HARNESS')).toBeLessThan(primer.indexOf('BEGIN AGENT'))
    expect(primer.indexOf('BEGIN AGENT')).toBeLessThan(primer.indexOf('BEGIN OBJECTIVE'))
  })

  it('composeLaunchPrimer omits the agent section for a plain (no-agent) launch', () => {
    const primer = composeLaunchPrimer({ objective: 'plain work' })
    expect(primer).toContain('BEGIN HARNESS')
    expect(primer).not.toContain('BEGIN AGENT')
    expect(primer).toContain('plain work')
  })
})

describe('S8 validateLaunchRequest — agentRelPath validation (R7)', () => {
  const known = (id: string) => id === 'p1'
  const base = {
    projectId: 'p1', provider: 'claude', model: 'claude-sonnet-4-6', objective: 'x',
    cwd: '/tmp/p1', useContainer: false, taskKind: 'product', taskSubkind: 'feature'
  }
  // model membership: use whatever the registry says is valid — pull a real one.
  // (validate.ts checks isKnownModel; a bad model would throw before agentRelPath.)

  it('accepts a registered agentRelPath', () => {
    const req = validateLaunchRequest({ ...base, agentRelPath: 'agents/release-writer.md' }, known, (r) => r === 'agents/release-writer.md')
    expect(req.agentRelPath).toBe('agents/release-writer.md')
  })

  it('rejects an unregistered agentRelPath', () => {
    expect(() => validateLaunchRequest({ ...base, agentRelPath: 'agents/evil.md' }, known, () => false))
      .toThrow(/not a registered library agent/)
  })

  it('leaves agentRelPath null when omitted (plain launch)', () => {
    const req = validateLaunchRequest(base, known)
    expect(req.agentRelPath).toBeNull()
  })

  it('rejects a non-string agentRelPath', () => {
    expect(() => validateLaunchRequest({ ...base, agentRelPath: 42 }, known, () => true))
      .toThrow(/agentRelPath/)
  })
})
