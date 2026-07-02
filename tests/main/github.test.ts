import { describe, it, expect, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseRepoList, buildHistorySyncCommands, syncHistory, isNothingToCommit } from '../../src/main/github'

const pexec = promisify(execFile)

describe('parseRepoList', () => {
  it('parses gh repo list JSON into {repo,name}', () => {
    const json = JSON.stringify([
      { nameWithOwner: 'example/sample-api', name: 'sample-api' },
      { nameWithOwner: 'example/sample-cli', name: 'sample-cli' }
    ])
    expect(parseRepoList(json)).toEqual([
      { repo: 'example/sample-api', name: 'sample-api' },
      { repo: 'example/sample-cli', name: 'sample-cli' }
    ])
  })

  it('returns [] for empty output', () => {
    expect(parseRepoList('[]')).toEqual([])
  })
})

describe('buildHistorySyncCommands', () => {
  it('produces add, commit, push with the given timestamp', () => {
    const cmds = buildHistorySyncCommands('2026-06-15T10:00:00Z')
    expect(cmds).toEqual([
      ['git', ['add', '-A']],
      ['git', ['commit', '-m', 'history: 2026-06-15T10:00:00Z']],
      ['git', ['push']]
    ])
  })
})

describe('isNothingToCommit (B8: only this is a benign no-op)', () => {
  it('recognizes git\'s nothing-to-commit messages', () => {
    expect(isNothingToCommit('nothing to commit, working tree clean')).toBe(true)
    expect(isNothingToCommit('nothing added to commit but untracked files present')).toBe(true)
    expect(isNothingToCommit('no changes added to commit')).toBe(true)
  })
  it('does NOT swallow real errors', () => {
    expect(isNothingToCommit('fatal: not a git repository')).toBe(false)
    expect(isNothingToCommit('error: failed to push some refs')).toBe(false)
    expect(isNothingToCommit('')).toBe(false)
  })
})

// B8: syncHistory now (a) operates ONLY on the IDE-owned history dir (renderer
// can't choose the directory) and (b) returns per-command status, ignoring ONLY
// "nothing to commit" — real failures are reported, not swallowed. Tested against
// a real temp git repo pointed at by AGENT_IDE_HISTORY.
describe('syncHistory (B8)', () => {
  async function tmpGitRepo(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'agide-hist-'))
    await pexec('git', ['init'], { cwd: dir })
    await pexec('git', ['config', 'user.email', 't@t'], { cwd: dir })
    await pexec('git', ['config', 'user.name', 'T'], { cwd: dir })
    await pexec('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir })
    return dir
  }

  it('commits changes and reports each step (push fails w/o a remote — reported, not swallowed)', async () => {
    const dir = await tmpGitRepo()
    process.env.AGENT_IDE_HISTORY = dir
    writeFileSync(join(dir, 's1.log'), 'session output')

    const results = await syncHistory('2026-07-02T00:00:00Z')
    const byStep = Object.fromEntries(results.map((r) => [r.step, r]))
    expect(byStep['add'].ok).toBe(true)
    expect(byStep['commit'].ok).toBe(true)   // there WAS something to commit
    expect(byStep['commit'].skipped).toBeFalsy()
    expect(byStep['push'].ok).toBe(false)     // no remote configured — real failure surfaced
    expect(byStep['push'].error).toBeTruthy()

    delete process.env.AGENT_IDE_HISTORY
    rmSync(dir, { recursive: true, force: true })
  })

  it('reports commit as a benign skip when there is nothing to commit', async () => {
    const dir = await tmpGitRepo()
    process.env.AGENT_IDE_HISTORY = dir
    // make one commit so the tree is clean afterward
    writeFileSync(join(dir, 'a.log'), 'x')
    await pexec('git', ['add', '-A'], { cwd: dir })
    await pexec('git', ['commit', '-m', 'seed'], { cwd: dir })

    const results = await syncHistory('2026-07-02T00:00:00Z')
    const commit = results.find((r) => r.step === 'commit')!
    expect(commit.ok).toBe(true)      // benign
    expect(commit.skipped).toBe(true) // nothing to commit

    delete process.env.AGENT_IDE_HISTORY
    rmSync(dir, { recursive: true, force: true })
  })

  it('ignores any directory argument — always uses the IDE-owned history dir', async () => {
    // Even if a (compromised) caller passed a path, the signature no longer
    // accepts one; syncHistory resolves the dir itself. This test documents that
    // by confirming it operates on AGENT_IDE_HISTORY regardless.
    const dir = await tmpGitRepo()
    process.env.AGENT_IDE_HISTORY = dir
    writeFileSync(join(dir, 'only-here.log'), 'y')
    const results = await syncHistory('2026-07-02T00:00:00Z')
    expect(results.find((r) => r.step === 'add')!.ok).toBe(true)
    // the commit landed in OUR dir
    const { stdout } = await pexec('git', ['log', '--oneline'], { cwd: dir })
    expect(stdout).toContain('history: 2026-07-02T00:00:00Z')
    delete process.env.AGENT_IDE_HISTORY
    rmSync(dir, { recursive: true, force: true })
  })
})
