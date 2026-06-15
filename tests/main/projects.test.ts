import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectDevcontainer, localPathFor, projectFromRepo } from '../../src/main/projects'

describe('detectDevcontainer', () => {
  it('true when .devcontainer/devcontainer.json exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agide-'))
    mkdirSync(join(dir, '.devcontainer'))
    writeFileSync(join(dir, '.devcontainer', 'devcontainer.json'), '{}')
    expect(detectDevcontainer(dir)).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it('true when a root .devcontainer.json exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agide-'))
    writeFileSync(join(dir, '.devcontainer.json'), '{}')
    expect(detectDevcontainer(dir)).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it('false when no devcontainer config present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agide-'))
    expect(detectDevcontainer(dir)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('localPathFor', () => {
  it('joins the root with the repo short name', () => {
    expect(localPathFor('/home/me/AgentIDE', 'example/sample-api')).toBe('/home/me/AgentIDE/sample-api')
  })
})

describe('projectFromRepo', () => {
  it('builds a Project with a stable id from the repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agide-'))
    const p = projectFromRepo('example/sample-cli', dir)
    expect(p.repo).toBe('example/sample-cli')
    expect(p.name).toBe('sample-cli')
    expect(p.localPath).toBe(dir)
    expect(p.hasDevcontainer).toBe(false)
    expect(p.id).toBeTruthy()
    rmSync(dir, { recursive: true, force: true })
  })
})
