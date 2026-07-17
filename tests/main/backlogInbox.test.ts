import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../src/main/store'
import { BacklogInbox, parseInbox, inboxHash } from '../../src/main/backlogInbox'

// --- pure parser -------------------------------------------------------------
describe('parseInbox', () => {
  it('parses kind/title/parent-title + body', () => {
    const r = parseInbox('---\nkind: epic\ntitle: Ship it\nparent-title: Q3\n---\nBody text\n')
    expect('ok' in r).toBe(true)
    if ('ok' in r) {
      expect(r.ok.kind).toBe('epic')
      expect(r.ok.title).toBe('Ship it')
      expect(r.ok.parentTitle).toBe('Q3')
      expect(r.ok.bodyMd).toBe('Body text')
    }
  })

  it('accepts `parent` as an alias for parent-title (harness default text)', () => {
    const r = parseInbox('---\nkind: goal\ntitle: G\nparent: Epic One\n---\n')
    expect('ok' in r && r.ok.parentTitle).toBe('Epic One')
  })

  it('rejects a missing frontmatter fence', () => {
    expect('error' in parseInbox('no frontmatter here')).toBe(true)
  })

  it('rejects an unknown kind', () => {
    expect('error' in parseInbox('---\nkind: bogus\ntitle: X\n---\n')).toBe(true)
  })

  it('rejects a missing title', () => {
    expect('error' in parseInbox('---\nkind: task\n---\n')).toBe(true)
  })
})

// --- full ingestion ----------------------------------------------------------
describe('BacklogInbox ingestion', () => {
  let base: string
  let projectRoot: string
  let store: Store
  let inbox: BacklogInbox
  let inboxDir: string

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'agide-inbox-'))
    projectRoot = join(base, 'proj')
    inboxDir = join(projectRoot, 'backlog', 'inbox')
    mkdirSync(inboxDir, { recursive: true })
    store = new Store(':memory:')
    store.saveProject({ id: 'p1', name: 'proj', repo: 'me/p', localPath: projectRoot, hasDevcontainer: false })
    inbox = new BacklogInbox(store)
  })
  afterEach(() => { inbox.stop(); try { rmSync(base, { recursive: true, force: true }) } catch { /* */ } })

  // The manager's scan is private; exercise it via start() + a settle wait.
  const settle = () => new Promise((r) => setTimeout(r, 120))

  it('ingests a valid file → backlog item + moves file to ingested/', async () => {
    writeFileSync(join(inboxDir, 'epic.md'), '---\nkind: epic\ntitle: My Epic\n---\nDo the thing.\n')
    inbox.start()
    await settle()
    const items = store.listBacklog('p1')
    expect(items.length).toBe(1)
    expect(items[0].kind).toBe('epic')
    expect(items[0].title).toBe('My Epic')
    expect(items[0].source).toBe('agent')
    // original moved out; ingested/ has one file
    expect(existsSync(join(inboxDir, 'epic.md'))).toBe(false)
    expect(readdirSync(join(inboxDir, 'ingested')).length).toBe(1)
  })

  it('resolves parent-title within the project', async () => {
    const epic = store.createBacklogItem({ projectId: 'p1', kind: 'epic', title: 'Parent Epic' }).item!
    writeFileSync(join(inboxDir, 'g.md'), '---\nkind: goal\ntitle: Child Goal\nparent-title: Parent Epic\n---\n')
    inbox.start()
    await settle()
    const goal = store.listBacklog('p1').find((i) => i.title === 'Child Goal')!
    expect(goal.parentId).toBe(epic.id)
  })

  it('dedupes by contentHash: same content ingested once', async () => {
    const md = '---\nkind: task\ntitle: Dupe\n---\nsame body\n'
    writeFileSync(join(inboxDir, 'a.md'), md)
    inbox.start()
    await settle()
    expect(store.listBacklog('p1').length).toBe(1)
    // a second file with identical content → skipped (moved, not re-ingested)
    writeFileSync(join(inboxDir, 'b.md'), md)
    await settle(); await settle()
    expect(store.listBacklog('p1').length).toBe(1)
    expect(store.listBacklog('p1')[0].contentHash).toBe(inboxHash(md))
  })

  it('moves a malformed file to rejected/ with a .reason.txt (never deletes)', async () => {
    writeFileSync(join(inboxDir, 'bad.md'), 'no frontmatter at all')
    inbox.start()
    await settle()
    expect(store.listBacklog('p1').length).toBe(0)
    const rejected = readdirSync(join(inboxDir, 'rejected'))
    expect(rejected.some((f) => f.endsWith('.md'))).toBe(true)
    const reason = rejected.find((f) => f.endsWith('.reason.txt'))!
    expect(reason).toBeTruthy()
    expect(readFileSync(join(inboxDir, 'rejected', reason), 'utf8')).toMatch(/frontmatter/)
  })

  it('refuses a symlinked inbox entry (does not ingest, does not follow)', async () => {
    // Create a real file OUTSIDE the inbox and symlink it in.
    const outside = join(base, 'secret.md')
    writeFileSync(outside, '---\nkind: task\ntitle: Sneaky\n---\n')
    try { symlinkSync(outside, join(inboxDir, 'link.md')) } catch { return /* platform w/o symlink */ }
    inbox.start()
    await settle()
    expect(store.listBacklog('p1').find((i) => i.title === 'Sneaky')).toBeUndefined()
    // the outside file is untouched (never deleted/moved)
    expect(existsSync(outside)).toBe(true)
  })

  it('rejects a file over the 256KB cap', async () => {
    const big = '---\nkind: task\ntitle: Big\n---\n' + 'x'.repeat(256 * 1024 + 10)
    writeFileSync(join(inboxDir, 'big.md'), big)
    inbox.start()
    await settle()
    expect(store.listBacklog('p1').length).toBe(0)
    const reason = readdirSync(join(inboxDir, 'rejected')).find((f) => f.endsWith('.reason.txt'))!
    expect(readFileSync(join(inboxDir, 'rejected', reason), 'utf8')).toMatch(/exceeds/)
  })
})
