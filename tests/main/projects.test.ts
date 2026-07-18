import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import {
  detectDevcontainer,
  localPathFor,
  projectFromRepo,
  projectFromPath,
  projectId
} from '../../src/main/projects'
import { repoNameFromUrl } from '../../src/main/github'

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

describe('projectFromPath', () => {
  it('derives name from the folder basename, empty repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'my-proj-'))
    const p = projectFromPath(dir)
    expect(p.repo).toBe('')
    expect(p.name).toBe(basename(dir))
    expect(p.localPath).toBe(dir)
    rmSync(dir, { recursive: true, force: true })
  })
})

// B7: project id must be a durable hash of the project's canonical identity (repo
// URL or absolute local path), NOT a kebab of its basename — otherwise owner1/app,
// owner2/app and /tmp/app all collapse to "proj-app" and overwrite each other in
// the store (id is the PRIMARY KEY).
describe('projectId (B7 durable, collision-free)', () => {
  it('is deterministic for the same identity', () => {
    expect(projectId('owner/app', '/home/me/AgentIDE/app')).toBe(
      projectId('owner/app', '/home/me/AgentIDE/app')
    )
  })

  it('distinguishes two repos that share a basename (the B7 collision)', () => {
    const a = projectId('owner1/app', '/a/app')
    const b = projectId('owner2/app', '/b/app')
    expect(a).not.toBe(b)
  })

  it('distinguishes a repo project from a local folder with the same basename', () => {
    const repo = projectId('owner/app', '/x/app')
    const local = projectId('', '/tmp/app') // no remote — keyed by path
    expect(repo).not.toBe(local)
  })

  it('distinguishes two local folders with the same basename at different paths', () => {
    expect(projectId('', '/home/me/app')).not.toBe(projectId('', '/tmp/app'))
  })

  it('keys a repo by its remote regardless of clone location', () => {
    // same repo cloned to two different dirs is the same logical project
    expect(projectId('owner/app', '/a/app')).toBe(projectId('owner/app', '/b/app'))
  })

  it('normalizes a trailing .git and slash on the repo', () => {
    expect(projectId('owner/app.git', '/a/app')).toBe(projectId('owner/app', '/a/app'))
  })

  it('produces a proj- prefixed id', () => {
    expect(projectId('owner/app', '/a/app')).toMatch(/^proj-[0-9a-f]+$/)
  })
})

describe('repoNameFromUrl', () => {
  it('extracts the repo name from various git URL forms', () => {
    expect(repoNameFromUrl('https://github.com/me/cool-repo.git')).toBe('cool-repo')
    expect(repoNameFromUrl('git@github.com:me/cool-repo.git')).toBe('cool-repo')
    expect(repoNameFromUrl('https://gitlab.com/group/sub/thing')).toBe('thing')
  })
})
