import { watch, type FSWatcher } from 'node:fs'
import { readFile, readdir, mkdir, rename, writeFile, stat, lstat } from 'node:fs/promises'
import { join, basename, extname } from 'node:path'
import { createHash } from 'node:crypto'
import { parse as parseYaml } from 'yaml'
import { confinedPath } from './confine'
import type { Store } from './store'
import type { BacklogKind } from '@shared/types'

// S1 inbox ingestion (C-18/R21): watch <project>/backlog/inbox/*.md, parse
// frontmatter {kind, title, parent-title?}, dedupe by contentHash (transactional
// ingest-or-skip in the Store), and MOVE (never delete) ingested files to
// inbox/ingested/ and malformed ones to inbox/rejected/ with a .reason.txt.
// Symlink-confined via confinedPath so a link can't pull in a file from outside.

const MAX_BYTES = 256 * 1024 // 256KB cap per inbox file
const SETTLE_MS = 500 // debounce a burst of writes before ingesting
const RESCAN_MS = 3000 // interval rescan (also picks up new projects)
const KINDS: readonly BacklogKind[] = ['epic', 'goal', 'task', 'ticket']

interface Parsed {
  kind: BacklogKind
  title: string
  parentTitle?: string
  bodyMd: string
}

/** Split a leading `---\n…\n---\n` YAML frontmatter block from the body. Returns
 *  null if there is no well-formed fence (a malformed file → rejected). */
function splitFrontmatter(text: string): { fm: string; body: string } | null {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) return null
  return { fm: m[1], body: m[2] }
}

/** Parse an inbox file's text into a validated item, or an error reason. */
export function parseInbox(text: string): { ok: Parsed } | { error: string } {
  const split = splitFrontmatter(text)
  if (!split) return { error: 'missing YAML frontmatter (expected a leading --- … --- block)' }
  let meta: unknown
  try {
    meta = parseYaml(split.fm)
  } catch (err) {
    return { error: `invalid YAML frontmatter: ${(err as Error).message}` }
  }
  if (!meta || typeof meta !== 'object') return { error: 'frontmatter is not a mapping' }
  const m = meta as Record<string, unknown>
  const kind = m.kind
  if (typeof kind !== 'string' || !KINDS.includes(kind as BacklogKind)) {
    return { error: `invalid kind: expected one of ${KINDS.join('|')}` }
  }
  const title = m.title
  if (typeof title !== 'string' || !title.trim()) return { error: 'missing title' }
  // Accept both `parent-title` (documented) and `parent` (harness default text).
  const parentRaw = m['parent-title'] ?? m.parent
  const parentTitle = typeof parentRaw === 'string' && parentRaw.trim() ? parentRaw.trim() : undefined
  return { ok: { kind: kind as BacklogKind, title: title.trim(), parentTitle, bodyMd: split.body.trim() } }
}

/** contentHash used for idempotent dedupe (an edited file = new hash = new item). */
export function inboxHash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Collision-safe destination name: base + short hash suffix (R21-minor). */
function safeDestName(name: string, hash: string): string {
  const ext = extname(name)
  const stem = basename(name, ext)
  return `${stem}.${hash.slice(0, 8)}${ext}`
}

/** One project's inbox watcher. Serialises scans so a burst of fs events can't
 *  race two ingests of the same file. */
class ProjectInbox {
  private readonly inboxDir: string
  private readonly ingestedDir: string
  private readonly rejectedDir: string
  private watcher?: FSWatcher
  private settleTimer?: NodeJS.Timeout
  private scanning = false
  private rescanQueued = false

  constructor(
    private readonly projectId: string,
    localPath: string,
    private readonly store: Store
  ) {
    this.inboxDir = join(localPath, 'backlog', 'inbox')
    this.ingestedDir = join(this.inboxDir, 'ingested')
    this.rejectedDir = join(this.inboxDir, 'rejected')
  }

  async start(): Promise<void> {
    await mkdir(this.inboxDir, { recursive: true }).catch(() => {})
    // fs.watch: coalesce a burst of events behind a settle timer.
    try {
      this.watcher = watch(this.inboxDir, () => this.scheduleScan())
    } catch {
      /* dir may vanish; the interval rescan recovers */
    }
    await this.scan()
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = undefined
    if (this.settleTimer) clearTimeout(this.settleTimer)
  }

  scheduleScan(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer)
    this.settleTimer = setTimeout(() => {
      void this.scan()
    }, SETTLE_MS)
  }

  /** Scan the inbox once; ingest or reject every top-level *.md file. */
  async scan(): Promise<void> {
    if (this.scanning) {
      this.rescanQueued = true
      return
    }
    this.scanning = true
    try {
      let entries: string[]
      try {
        entries = await readdir(this.inboxDir)
      } catch {
        return
      }
      for (const name of entries) {
        if (!name.toLowerCase().endsWith('.md')) continue
        await this.ingestFile(name).catch((err) =>
          console.error('[inbox] ingest failed', name, (err as Error).message)
        )
      }
    } finally {
      this.scanning = false
      if (this.rescanQueued) {
        this.rescanQueued = false
        void this.scan()
      }
    }
  }

  private async ingestFile(name: string): Promise<void> {
    // Symlink-confine the target within the inbox dir (refuses links out).
    const real = confinedPath(this.inboxDir, name)
    if (!real) return this.reject(name, null, 'path escapes the inbox (symlink or traversal refused)')

    // Refuse symlinks and non-regular files outright.
    const ls = await lstat(real).catch(() => null)
    if (!ls || !ls.isFile()) {
      if (ls?.isSymbolicLink()) return this.reject(name, null, 'symlink refused')
      return // directory / socket / vanished — skip
    }
    const st = await stat(real).catch(() => null)
    if (!st) return
    if (st.size > MAX_BYTES) return this.reject(name, null, `file exceeds ${MAX_BYTES} bytes`)

    const text = await readFile(real, 'utf8')
    const parsed = parseInbox(text)
    if ('error' in parsed) return this.reject(name, text, parsed.error)

    const p = parsed.ok
    // Resolve an optional parent by title within this project (best-effort; an
    // unresolved parent ingests at top level rather than rejecting the file).
    let parentId: string | null = null
    if (p.parentTitle) {
      const match = this.store.listBacklog(this.projectId).find((i) => i.title === p.parentTitle)
      parentId = match?.id ?? null
    }
    const contentHash = inboxHash(text)
    // Transactional ingest-or-skip keyed on contentHash. A duplicate returns null;
    // we still MOVE the file out of the inbox (idempotent).
    let item
    try {
      item = this.store.ingestAgentBacklogItem({
        projectId: this.projectId,
        kind: p.kind,
        title: p.title,
        bodyMd: p.bodyMd,
        parentId,
        contentHash
      })
    } catch (err) {
      // A hierarchy violation (e.g. parent can't nest this kind) surfaces here.
      return this.reject(name, text, `ingest rejected: ${(err as Error).message}`)
    }
    await this.moveTo(this.ingestedDir, name, real, contentHash)
    if (item) console.log('[inbox] ingested', name, '→', item.id)
  }

  /** Move a source file into dir with a collision-safe name (never delete). */
  private async moveTo(dir: string, name: string, srcReal: string, hash: string): Promise<void> {
    await mkdir(dir, { recursive: true }).catch(() => {})
    const dest = join(dir, safeDestName(name, hash))
    await rename(srcReal, dest).catch((err) =>
      console.error('[inbox] move failed', name, (err as Error).message)
    )
  }

  /** Move a malformed file to rejected/ with a sibling .reason.txt (never delete). */
  private async reject(name: string, text: string | null, reason: string): Promise<void> {
    const hash = inboxHash((text ?? '') + reason)
    const real = confinedPath(this.inboxDir, name)
    await mkdir(this.rejectedDir, { recursive: true }).catch(() => {})
    const destName = safeDestName(name, hash)
    if (real) {
      const dest = join(this.rejectedDir, destName)
      await rename(real, dest).catch((err) =>
        console.error('[inbox] reject move failed', name, (err as Error).message)
      )
    }
    await writeFile(join(this.rejectedDir, `${destName}.reason.txt`), reason + '\n', 'utf8').catch(() => {})
    console.warn('[inbox] rejected', name, '—', reason)
  }
}

/** Manages one ProjectInbox per registered project; picks up new projects on an
 *  interval rescan (projects are added at runtime through the frozen ipc.ts). */
export class BacklogInbox {
  private readonly byProject = new Map<string, ProjectInbox>()
  private timer?: NodeJS.Timeout

  constructor(private readonly store: Store) {}

  /** Start watching every current project and (re)sync the project set on an
   *  interval. Returns immediately; per-project scans run in the background. */
  start(): void {
    void this.sync()
    this.timer = setInterval(() => {
      void this.sync()
    }, RESCAN_MS)
    if (this.timer.unref) this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    for (const pi of this.byProject.values()) pi.stop()
    this.byProject.clear()
  }

  /** Reconcile watchers against the current project list and rescan each inbox. */
  private async sync(): Promise<void> {
    let projects: { id: string; localPath: string }[] = []
    try {
      projects = this.store.listProjects()
    } catch {
      return
    }
    const live = new Set<string>()
    for (const p of projects) {
      if (!p.localPath) continue
      live.add(p.id)
      let pi = this.byProject.get(p.id)
      if (!pi) {
        pi = new ProjectInbox(p.id, p.localPath, this.store)
        this.byProject.set(p.id, pi)
        await pi.start()
      } else {
        await pi.scan()
      }
    }
    // Drop watchers for projects that disappeared.
    for (const [id, pi] of this.byProject) {
      if (!live.has(id)) {
        pi.stop()
        this.byProject.delete(id)
      }
    }
  }
}
