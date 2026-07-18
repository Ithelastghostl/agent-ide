import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseStatusPorcelainV2,
  isDetached,
  parseDiffStat,
  sliceToBytes,
  DIFF_CAP_BYTES,
  isGitRepo,
  gitStatusSummary,
  gitWorkingDiff
} from '../../src/main/gitInfo'

// Fixtures modelled on real `git status --porcelain=v2 --branch` output. Header
// lines start with "# branch.*"; entry lines start with '1'/'2'/'u'/'?'.

describe('parseStatusPorcelainV2', () => {
  it('clean repo on a branch with an upstream', () => {
    const out = [
      '# branch.oid 1111111111111111111111111111111111111111',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +0 -0',
      ''
    ].join('\n')
    expect(parseStatusPorcelainV2(out)).toEqual({ branch: 'main', ahead: 0, behind: 0, dirtyCount: 0 })
  })

  it('dirty repo: staged + unstaged + untracked entries all count', () => {
    const out = [
      '# branch.oid 2222222222222222222222222222222222222222',
      '# branch.head feature/x',
      '1 M. N... 100644 100644 100644 aaa bbb staged.ts', // ordinary change (staged)
      '1 .M N... 100644 100644 100644 ccc ddd unstaged.ts', // ordinary change (unstaged)
      '? untracked.txt', // untracked
      ''
    ].join('\n')
    expect(parseStatusPorcelainV2(out)).toEqual({ branch: 'feature/x', ahead: 0, behind: 0, dirtyCount: 3 })
  })

  it('ahead/behind parsed from branch.ab', () => {
    const out = [
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +3 -2',
      '1 .M N... 100644 100644 100644 ccc ddd f.ts',
      ''
    ].join('\n')
    expect(parseStatusPorcelainV2(out)).toEqual({ branch: 'main', ahead: 3, behind: 2, dirtyCount: 1 })
  })

  it('renamed (2) and unmerged (u) entries count toward dirtyCount', () => {
    const out = [
      '# branch.head main',
      '2 R. N... 100644 100644 100644 aaa bbb R100 new.ts\told.ts', // rename
      'u UU N... 100644 100644 100644 100644 xxx yyy zzz conflict.ts', // unmerged
      ''
    ].join('\n')
    const r = parseStatusPorcelainV2(out)
    expect(r.dirtyCount).toBe(2)
    expect(r.branch).toBe('main')
  })

  it('detached HEAD → branch is "(detached)" and isDetached is true', () => {
    const out = [
      '# branch.oid 3333333333333333333333333333333333333333',
      '# branch.head (detached)',
      ''
    ].join('\n')
    const r = parseStatusPorcelainV2(out)
    expect(r.branch).toBe('(detached)')
    expect(isDetached(r)).toBe(true)
    expect(r.dirtyCount).toBe(0)
  })

  it('no upstream → ahead/behind default to 0 (no branch.ab line)', () => {
    const out = ['# branch.oid 4444444444444444444444444444444444444444', '# branch.head main', ''].join('\n')
    expect(parseStatusPorcelainV2(out)).toEqual({ branch: 'main', ahead: 0, behind: 0, dirtyCount: 0 })
  })

  it('empty / non-repo-ish input yields an empty summary (never throws)', () => {
    expect(parseStatusPorcelainV2('')).toEqual({ branch: '', ahead: 0, behind: 0, dirtyCount: 0 })
    expect(isDetached(parseStatusPorcelainV2(''))).toBe(false)
  })

  it('unborn branch (initial commit) still reports the branch head', () => {
    const out = ['# branch.oid (initial)', '# branch.head main', '? first.ts', ''].join('\n')
    expect(parseStatusPorcelainV2(out)).toEqual({ branch: 'main', ahead: 0, behind: 0, dirtyCount: 1 })
  })
})

describe('parseDiffStat', () => {
  const stat = [
    ' src/a.ts | 5 +++--',
    ' src/b.ts | 2 +-',
    ' 2 files changed, 4 insertions(+), 3 deletions(-)'
  ].join('\n')

  it('parses files/insertions/deletions from the footer', () => {
    expect(parseDiffStat(stat)).toEqual({ filesChanged: 2, insertions: 4, deletions: 3 })
  })

  it('handles singular "1 file changed" and insertions-only', () => {
    const s = ' README.md | 1 +\n 1 file changed, 1 insertion(+)'
    expect(parseDiffStat(s)).toEqual({ filesChanged: 1, insertions: 1, deletions: 0 })
  })

  it('handles deletions-only', () => {
    const s = ' gone.ts | 3 ---\n 1 file changed, 3 deletions(-)'
    expect(parseDiffStat(s)).toEqual({ filesChanged: 1, insertions: 0, deletions: 3 })
  })

  it('empty / clean stat → all zeros (never throws)', () => {
    expect(parseDiffStat('')).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 })
    expect(parseDiffStat('  \n \n')).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 })
  })
})

describe('sliceToBytes (diff cap helper)', () => {
  it('returns the string unchanged when under the cap', () => {
    expect(sliceToBytes('hello', 100)).toBe('hello')
  })

  it('caps to at most maxBytes UTF-8 bytes', () => {
    const s = 'a'.repeat(1000)
    const out = sliceToBytes(s, 100)
    expect(Buffer.byteLength(out, 'utf8')).toBe(100)
  })

  it('never splits a multi-byte codepoint (backs off to a boundary)', () => {
    // '€' is 3 bytes in UTF-8. Cap at 2 bytes → must not emit half a char.
    const out = sliceToBytes('€€', 2)
    expect(out).toBe('') // can't fit even one full char → empty, no mojibake
    const out2 = sliceToBytes('€€', 4) // room for one full char (3 bytes) only
    expect(out2).toBe('€')
  })

  it('DIFF_CAP_BYTES is 512KB', () => {
    expect(DIFF_CAP_BYTES).toBe(512 * 1024)
  })
})

// Real-git integration: exercises the execFile paths (isGitRepo / status / diff)
// against throwaway temp repos. git is a hard dependency of the app already.
describe('git invocation against a real temp repo', () => {
  let repo = ''
  let plain = ''

  function git(dir: string, ...args: string[]) {
    execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' })
  }

  beforeAll(() => {
    // A repo with one commit + an uncommitted edit + an untracked file.
    repo = mkdtempSync(join(tmpdir(), 'gitinfo-repo-'))
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    writeFileSync(join(repo, 'tracked.txt'), 'one\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'initial')
    writeFileSync(join(repo, 'tracked.txt'), 'one\ntwo\n') // unstaged edit
    writeFileSync(join(repo, 'fresh.txt'), 'new\n') // untracked

    // A plain (non-git) directory.
    plain = mkdtempSync(join(tmpdir(), 'gitinfo-plain-'))
    mkdirSync(join(plain, 'sub'))
  })

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(plain, { recursive: true, force: true })
  })

  it('isGitRepo distinguishes repo from non-repo', async () => {
    expect(await isGitRepo(repo)).toBe(true)
    expect(await isGitRepo(plain)).toBe(false)
  })

  it('gitStatusSummary reports branch + dirty count for the temp repo', async () => {
    const s = await gitStatusSummary(repo)
    expect(s).not.toBeNull()
    expect(s!.branch).toBe('main')
    expect(s!.dirtyCount).toBeGreaterThanOrEqual(2) // edited + untracked
  })

  it('gitStatusSummary returns null for a non-repo (never throws)', async () => {
    expect(await gitStatusSummary(plain)).toBeNull()
  })

  it('gitWorkingDiff surfaces the seeded change in stat + patch, not truncated', async () => {
    const d = await gitWorkingDiff(repo)
    expect(d).not.toBeNull()
    expect(d!.truncated).toBe(false)
    expect(d!.patch).toContain('tracked.txt')
    expect(d!.patch).toContain('+two')
    // The stat footer parses to a structured summary.
    const summary = parseDiffStat(d!.stat)
    expect(summary.filesChanged).toBeGreaterThanOrEqual(1)
    expect(summary.insertions).toBeGreaterThanOrEqual(1)
  })

  it('gitWorkingDiff returns null for a non-repo', async () => {
    expect(await gitWorkingDiff(plain)).toBeNull()
  })

  it('detached HEAD is reported as "(detached)"', async () => {
    const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    git(repo, 'checkout', '-q', head) // detach onto the commit sha
    const s = await gitStatusSummary(repo)
    expect(s).not.toBeNull()
    expect(isDetached(s!)).toBe(true)
    git(repo, 'checkout', '-q', 'main') // re-attach for any later assertions
  })
})
