import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readHarness,
  writeHarness,
  harnessPath,
  DEFAULT_HARNESS,
  CONTAINER_HARNESS_PATH
} from '../../src/main/harness'

describe('harness get/set + default', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agide-harness-'))
    process.env.AGENT_IDE_HARNESS = dir
  })
  afterEach(() => {
    delete process.env.AGENT_IDE_HARNESS
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates the default harness on first read and references the container path', () => {
    const text = readHarness()
    expect(text).toBe(DEFAULT_HARNESS)
    expect(text).toContain('Discussion')
    expect(text).toContain('Playback')
    expect(text).toContain('Fix')
    expect(text).toContain('backlog/inbox')
    // written to disk
    expect(readFileSync(harnessPath(), 'utf8')).toBe(DEFAULT_HARNESS)
  })

  it('round-trips a custom harness', () => {
    expect(writeHarness('# custom harness').ok).toBe(true)
    expect(readHarness()).toBe('# custom harness')
  })

  it('exposes the root-owned container path (R4-3)', () => {
    expect(CONTAINER_HARNESS_PATH).toBe('/opt/agent-ide/HARNESS.md')
  })
})
