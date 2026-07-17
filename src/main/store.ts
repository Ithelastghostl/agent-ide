import Database from 'better-sqlite3'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'
import type { Project, Session, SessionStatus, Ticket } from '@shared/types'
import { projectId as durableProjectId } from './projects'

export function defaultDbPath(): string {
  // AGENT_IDE_DB lets tests point at a throwaway DB instead of the user's real
  // store (e.g. ':memory:' or a tmp file). Unset in normal use.
  const override = process.env.AGENT_IDE_DB
  if (override) return override
  const dir = join(homedir(), 'AgentIDE')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'agent-ide.sqlite')
}

/** SQLite-backed persistence for projects, sessions, and transcripts. */
export class Store {
  private db: Database.Database
  // B6: buffer transcript chunks and flush them in a single transaction on a
  // short debounce (or when read/closed), instead of one synchronous INSERT per
  // PTY chunk on the main thread. High-frequency output no longer stalls the UI.
  private pending: { session_id: string; chunk: string; ts: number }[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private static readonly FLUSH_DEBOUNCE_MS = 100

  constructor(path: string = defaultDbPath()) {
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT, repo TEXT, localPath TEXT, hasDevcontainer INTEGER
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, projectId TEXT, provider TEXT, model TEXT,
        objective TEXT, status TEXT, createdAt INTEGER, updatedAt INTEGER
      );
      CREATE TABLE IF NOT EXISTS transcripts (
        session_id TEXT, chunk TEXT, ts INTEGER
      );
      -- M-LOG-b (§4.2): one row per ticketed task. body_md is the rendered ticket;
      -- fields_json is the schema-validated source (TicketFields).
      CREATE TABLE IF NOT EXISTS tickets (
        id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, projectId TEXT NOT NULL,
        subkind TEXT NOT NULL, title TEXT NOT NULL, bodyMd TEXT NOT NULL,
        fieldsJson TEXT NOT NULL, createdAt INTEGER NOT NULL
      );
      -- B6: index the transcript read path (WHERE session_id ORDER BY ts, ...).
      -- rowid is SQLite's implicit primary key and orders rows within equal ts,
      -- so (session_id, ts) covers the ORDER BY ts, rowid query without listing it.
      CREATE INDEX IF NOT EXISTS idx_transcripts_session ON transcripts(session_id, ts);
    `)
    this.migrateProjectIds() // B7: upgrade legacy kebab ids to durable hash ids
    this.migrateSessionTaskColumns() // M-LOG-a: add task label columns (additive)
  }

  /** B7: recompute each project's id as the durable hash of its (repo, localPath)
   *  identity and cascade the change to sessions.projectId, so legacy kebab ids
   *  (which collided on basename) are upgraded in place with no orphaned sessions.
   *  Idempotent: rows already at their durable id are left untouched. Skips a
   *  rename if the target id somehow already exists (avoids a PK clash). */
  migrateProjectIds(): void {
    const rows = this.db
      .prepare(`SELECT id, repo, localPath FROM projects`)
      .all() as { id: string; repo: string; localPath: string }[]
    const migrate = this.db.transaction((items: typeof rows) => {
      const exists = this.db.prepare(`SELECT 1 FROM projects WHERE id = ?`)
      const moveSessions = this.db.prepare(`UPDATE sessions SET projectId = ? WHERE projectId = ?`)
      const moveProject = this.db.prepare(`UPDATE projects SET id = ? WHERE id = ?`)
      for (const r of items) {
        const want = durableProjectId(r.repo ?? '', r.localPath ?? '')
        if (want === r.id) continue
        if (exists.get(want)) continue // don't clobber an existing durable row
        moveSessions.run(want, r.id)
        moveProject.run(want, r.id)
      }
    })
    migrate(rows)
  }

  saveProject(p: Project): void {
    this.db
      .prepare(
        `INSERT INTO projects (id,name,repo,localPath,hasDevcontainer) VALUES (@id,@name,@repo,@localPath,@hd)
         ON CONFLICT(id) DO UPDATE SET name=@name, repo=@repo, localPath=@localPath, hasDevcontainer=@hd`
      )
      .run({ ...p, hd: p.hasDevcontainer ? 1 : 0 })
  }

  listProjects(): Project[] {
    return this.db
      .prepare(`SELECT id,name,repo,localPath,hasDevcontainer FROM projects`)
      .all()
      .map((r: any) => ({ ...r, hasDevcontainer: !!r.hasDevcontainer }))
  }

  /** A single project by id, or undefined if unknown. Used by main to resolve a
   *  renderer-supplied projectId to its confined filesystem root (B1). */
  getProject(id: string): Project | undefined {
    const r: any = this.db
      .prepare(`SELECT id,name,repo,localPath,hasDevcontainer FROM projects WHERE id = ?`)
      .get(id)
    return r ? { ...r, hasDevcontainer: !!r.hasDevcontainer } : undefined
  }

  /** M-LOG-a (§4.2): additively add the task-label columns to `sessions`. Guarded
   *  by a pragma check so it's a no-op once applied (SQLite ADD COLUMN errors if
   *  the column exists). Existing rows get NULL (grandfathered — no retro-label). */
  migrateSessionTaskColumns(): void {
    const cols = new Set(
      (this.db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]).map((c) => c.name)
    )
    const add = (name: string, ddl: string) => {
      if (!cols.has(name)) this.db.exec(`ALTER TABLE sessions ADD COLUMN ${ddl}`)
    }
    add('taskKind', 'taskKind TEXT')       // 'product' | 'analysis' | NULL
    add('taskSubkind', 'taskSubkind TEXT') // 'code' | 'feature' | 'bug' | NULL
    add('taskStatus', 'taskStatus TEXT')   // 'open' | 'finished' | 'deployed' | 'ticketed' | NULL
    add('useContainer', 'useContainer INTEGER') // 1 | 0 | NULL (pre-migration rows)
  }

  saveSession(s: Session): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id,projectId,provider,model,objective,status,createdAt,updatedAt,taskKind,taskSubkind,taskStatus,useContainer)
         VALUES (@id,@projectId,@provider,@model,@objective,@status,@createdAt,@updatedAt,@taskKind,@taskSubkind,@taskStatus,@uc)
         ON CONFLICT(id) DO UPDATE SET status=@status, provider=@provider, model=@model, objective=@objective, updatedAt=@updatedAt,
           taskKind=@taskKind, taskSubkind=@taskSubkind, taskStatus=@taskStatus, useContainer=@uc`
      )
      .run({
        ...s,
        taskKind: s.taskKind ?? null,
        taskSubkind: s.taskSubkind ?? null,
        taskStatus: s.taskStatus ?? null,
        uc: s.useContainer == null ? null : s.useContainer ? 1 : 0
      })
  }

  /** SQLite stores useContainer as 0/1/NULL; the app type is boolean | null. */
  private static rowToSession(r: any): Session {
    return { ...r, useContainer: r.useContainer == null ? null : !!r.useContainer }
  }

  /** M-LOG-a: set a session's task lifecycle status (open→finished→deployed→
   *  ticketed). Separate from the runtime `status` (running/idle/archived). */
  setTaskStatus(id: string, taskStatus: string): void {
    this.db.prepare(`UPDATE sessions SET taskStatus = ? WHERE id = ?`).run(taskStatus, id)
  }

  /** M-LOG-b (§4.4): persist a generated ticket (idempotent per id). */
  saveTicket(t: Ticket): void {
    this.db
      .prepare(
        `INSERT INTO tickets (id,sessionId,projectId,subkind,title,bodyMd,fieldsJson,createdAt)
         VALUES (@id,@sessionId,@projectId,@subkind,@title,@bodyMd,@fieldsJson,@createdAt)
         ON CONFLICT(id) DO UPDATE SET title=@title, bodyMd=@bodyMd, fieldsJson=@fieldsJson`
      )
      .run(t)
  }

  /** Persist a ticket AND advance its session to 'ticketed' in ONE transaction —
   *  a crash can no longer leave a saved ticket on a still-'deployed' session. */
  finalizeTicket(t: Ticket): void {
    this.db.transaction(() => {
      this.saveTicket(t)
      this.setTaskStatus(t.sessionId, 'ticketed')
    })()
  }

  /** Tickets for a project, newest first (for the Log list). */
  getTickets(projectId: string): Ticket[] {
    return this.db
      .prepare(`SELECT * FROM tickets WHERE projectId = ? ORDER BY createdAt DESC`)
      .all(projectId) as Ticket[]
  }

  /** The ticket generated for a session, if any. */
  getTicketBySession(sessionId: string): Ticket | undefined {
    return this.db.prepare(`SELECT * FROM tickets WHERE sessionId = ?`).get(sessionId) as Ticket | undefined
  }

  getSessions(projectId: string): Session[] {
    return this.db
      .prepare(`SELECT * FROM sessions WHERE projectId = ? ORDER BY createdAt`)
      .all(projectId)
      .map(Store.rowToSession)
  }

  /** A single session by id, or undefined. Used by the M-LOG task lifecycle to
   *  read the current label/status before advancing it. */
  getSession(id: string): Session | undefined {
    const r = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id)
    return r ? Store.rowToSession(r) : undefined
  }

  allSessions(): Session[] {
    return this.db.prepare(`SELECT * FROM sessions ORDER BY createdAt`).all().map(Store.rowToSession)
  }

  archiveSession(id: string): void {
    const status: SessionStatus = 'archived'
    this.db.prepare(`UPDATE sessions SET status = ? WHERE id = ?`).run(status, id)
  }

  /** Permanently delete a session and its stored transcript (one transaction so a
   *  partial failure can't leave orphaned transcript rows). The on-disk history
   *  file is handled separately by the caller (see history.removeHistory). */
  deleteSession(id: string): void {
    const tx = this.db.transaction((sid: string) => {
      this.db.prepare(`DELETE FROM transcripts WHERE session_id = ?`).run(sid)
      this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sid)
    })
    tx(id)
  }

  renameSession(id: string, name: string): void {
    this.db.prepare(`UPDATE sessions SET objective = ? WHERE id = ?`).run(name, id)
  }

  setSessionStatus(id: string, status: SessionStatus): void {
    this.db.prepare(`UPDATE sessions SET status = ? WHERE id = ?`).run(status, id)
  }

  /** Queue a transcript chunk. Buffered and written in a batched transaction on a
   *  short debounce (B6) — not a synchronous per-chunk INSERT. A read or close
   *  flushes first, so no chunk is ever lost. */
  appendTranscript(sessionId: string, chunk: string, ts: number): void {
    this.pending.push({ session_id: sessionId, chunk, ts })
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), Store.FLUSH_DEBOUNCE_MS)
    }
  }

  /** Write all buffered transcript chunks in one transaction. Idempotent (a
   *  no-op when the buffer is empty) and safe to call from a timer, a read, or
   *  shutdown. */
  flush(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null }
    if (this.pending.length === 0) return
    const batch = this.pending
    this.pending = []
    const insert = this.db.prepare(`INSERT INTO transcripts (session_id,chunk,ts) VALUES (@session_id,@chunk,@ts)`)
    const writeAll = this.db.transaction((rows: typeof batch) => {
      for (const r of rows) insert.run(r)
    })
    writeAll(batch)
  }

  /** Full transcript for a session, oldest→newest, optionally tail-capped to the
   *  last `maxBytes` characters so replaying a huge log into xterm on mount stays
   *  fast. The cap keeps the END (most recent output), trimmed to a line start so
   *  replay doesn't begin mid-escape-sequence. B6: reads newest-first and stops
   *  once `maxBytes` is gathered, rather than concatenating the whole history. */
  getTranscript(sessionId: string, maxBytes = 256 * 1024): string {
    this.flush() // ensure buffered chunks are visible (primer must see the latest)
    const rows = this.db
      .prepare(`SELECT chunk FROM transcripts WHERE session_id = ? ORDER BY ts DESC, rowid DESC`)
      .all(sessionId) as { chunk: string }[]
    // Walk newest→oldest, prepending, until we have enough; then we can stop
    // reading further history entirely.
    const parts: string[] = []
    let len = 0
    for (const r of rows) {
      parts.push(r.chunk)
      len += r.chunk.length
      if (len >= maxBytes) break
    }
    const collected = parts.reverse().join('')
    if (len <= maxBytes) return collected
    const tail = collected.slice(collected.length - maxBytes)
    const nl = tail.indexOf('\n')
    return nl >= 0 ? tail.slice(nl + 1) : tail
  }
}
