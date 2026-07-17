import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, existsSync, readFileSync, symlinkSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../src/main/store'
import { writeRawLog, rawLogFrontmatter, projectRawLogDir, writeTicketFile, slugify, dateStamp, projectTicketsDir } from '../../src/main/projectLog'
import type { Session } from '@shared/types'

// M-LOG-a §4.3: a PRODUCT chat marked finished writes an ANSI-stripped raw log
// entry with YAML front-matter to <projects>/<id>/log/raw/<sessionId>.md.
describe('projectLog raw export (M-LOG-a §4.3)', () => {
  let root: string
  let store: Store
  const product: Session = {
    id: 'sess-1-99', projectId: 'proj-abc', provider: 'claude', model: 'claude-opus-4-8',
    objective: 'fix the thing', status: 'running', createdAt: 100, updatedAt: 200,
    taskKind: 'product', taskSubkind: 'bug', taskStatus: 'finished'
  }

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'agide-plog-')))
    process.env.AGENT_IDE_PROJECTS = root
    store = new Store(':memory:')
  })
  afterEach(() => {
    delete process.env.AGENT_IDE_PROJECTS
    rmSync(root, { recursive: true, force: true })
  })

  it('writes raw/<sessionId>.md with front-matter + stripped transcript', () => {
    store.appendTranscript('sess-1-99', '\x1b[32mhello\x1b[0m world\n', 1) // ANSI colored
    const path = writeRawLog(store, product, 12345)
    expect(path).toBe(join(root, 'proj-abc', 'log', 'raw', 'sess-1-99.md'))
    const text = readFileSync(path!, 'utf8')
    expect(text).toContain('task_kind: product')
    expect(text).toContain('task_subkind: bug')
    expect(text).toContain('provider: claude')
    expect(text).toContain('finished_at: 12345')
    expect(text).toContain('hello world')      // ANSI stripped
    expect(text).not.toContain('\x1b[32m')       // no raw escape codes
  })

  it('front-matter carries the label, provider/model, and dates', () => {
    const fm = rawLogFrontmatter(product, 999)
    expect(fm).toMatch(/^---\n/)
    expect(fm).toContain('session_id: sess-1-99')
    expect(fm).toContain('created_at: 100')
    expect(fm).toContain('updated_at: 200')
    expect(fm).toContain('finished_at: 999')
    expect(fm.trimEnd().endsWith('---')).toBe(true)
  })

  it('handles an empty transcript gracefully', () => {
    const path = writeRawLog(store, product, 1)
    expect(existsSync(path!)).toBe(true)
    expect(readFileSync(path!, 'utf8')).toContain('_(no transcript captured)_')
  })

  it('refuses a session id that would escape the log dir (confined)', () => {
    const evil: Session = { ...product, id: '../../etc/escape' }
    expect(writeRawLog(store, evil, 1)).toBeNull()
  })

  it('projectRawLogDir creates the nested log dir', () => {
    const dir = projectRawLogDir('proj-xyz')
    expect(existsSync(dir)).toBe(true)
    expect(dir).toBe(join(root, 'proj-xyz', 'log', 'raw'))
  })
})

// M-LOG-b (§4.3): tickets are written to log/tickets/<date>-<slug>.md.
describe('ticket file writing (M-LOG-b)', () => {
  let root: string
  beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'agide-tkt-'))); process.env.AGENT_IDE_PROJECTS = root })
  afterEach(() => { delete process.env.AGENT_IDE_PROJECTS; rmSync(root, { recursive: true, force: true }) })

  it('slugify makes a safe filename slug', () => {
    expect(slugify('Fix the Widget Race!')).toBe('fix-the-widget-race')
    expect(slugify('   ')).toBe('ticket')
  })
  it('dateStamp formats yyyy-mm-dd (UTC)', () => {
    expect(dateStamp(Date.UTC(2026, 6, 2, 15, 30))).toBe('2026-07-02')
  })
  it('writes tickets/ticket-<sessionId>.md (deterministic — retries overwrite)', () => {
    const p = writeTicketFile('proj-abc', 'sess-1-999', '# Fix widget race\nbody')
    expect(p).toBe(join(root, 'proj-abc', 'log', 'tickets', 'ticket-sess-1-999.md'))
    expect(readFileSync(p!, 'utf8')).toContain('# Fix widget race')
    const again = writeTicketFile('proj-abc', 'sess-1-999', '# updated')
    expect(again).toBe(p) // same session → same file, no orphaned variants
    expect(readFileSync(p!, 'utf8')).toContain('# updated')
  })
  it('projectTicketsDir creates the tickets dir', () => {
    const dir = projectTicketsDir('proj-q')
    expect(existsSync(dir)).toBe(true)
    expect(dir).toBe(join(root, 'proj-q', 'log', 'tickets'))
  })

  // SEC (review finding #1): a DANGLING symlink planted at the target name must not
  // let the write escape the confined dir. existsSync follows symlinks and returns
  // false for a dangling one, so a naive walk would re-append the name verbatim and
  // writeFileSync would follow the link outside the dir. confinedPath must refuse it.
  it('refuses a write through a dangling symlink whose target is outside the dir', () => {
    const outside = join(root, 'outside')
    mkdirSync(outside, { recursive: true })
    const dir = projectTicketsDir('proj-evil')
    const outsideTarget = join(outside, 'stolen.md') // does NOT exist yet (dangling)
    symlinkSync(outsideTarget, join(dir, 'ticket-evil.md')) // plant the trap

    const p = writeTicketFile('proj-evil', 'evil', '# pwned')
    expect(p).toBeNull()                 // refused
    expect(existsSync(outsideTarget)).toBe(false) // nothing written outside
  })
})
