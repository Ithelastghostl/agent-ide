import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, symlinkSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../src/main/store'
import { writeRawLog, rawLogFrontmatter, projectRawLogDir } from '../../src/main/projectLog'
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
    root = mkdtempSync(join(tmpdir(), 'agide-plog-'))
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
