import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'
import type {
  Project, Session, SessionStatus, Ticket,
  BacklogItem, BacklogKind, BacklogManualStatus, BacklogEffectiveStatus, BacklogCreateInput, BacklogUpdateInput,
  QueueItem, QueueState, Snapshot, SearchHit, ApprovalMode
} from '@shared/types'
import { projectId as durableProjectId } from './projects'

/** Runtime-active session statuses (R19-4): a session that owns or is reserving
 *  a pty. Used for backlog recomputation, queue eligibility, delete guards. */
const ACTIVE_STATUSES = new Set<SessionStatus>(['starting', 'running'])

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

/** Escape an FTS5 query so arbitrary user input can never be a syntax error:
 *  double any embedded double-quotes, then wrap each whitespace-separated term
 *  in double quotes so it is a literal phrase (R3-minors). */
export function ftsQuery(raw: string): string {
  const terms = raw.trim().split(/\s+/).filter(Boolean)
  if (!terms.length) return '""'
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ')
}

/** localEffectiveStatus precedence (R34): done-by-ticket > in-session > manual. */
export function effectiveStatus(i: Pick<BacklogItem, 'manualStatus' | 'sessionState'>): BacklogEffectiveStatus {
  if (i.sessionState === 'done-by-ticket') return 'done'
  if (i.sessionState === 'in-session') return 'in-session'
  return i.manualStatus
}

/** Allowed parent→child nesting (C-8): epic owns any; goal owns task/ticket;
 *  task/ticket are leaves. */
export function canNest(parentKind: BacklogKind, childKind: BacklogKind): boolean {
  if (parentKind === 'epic') return childKind !== 'epic'
  if (parentKind === 'goal') return childKind === 'task' || childKind === 'ticket'
  return false // task/ticket are leaves
}

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

      -- v2 backlog (P0.B). manualStatus + sessionState split (R33/R34); source
      -- authority enforced in Store methods (R17). FKs off by default in SQLite.
      CREATE TABLE IF NOT EXISTS backlog_items (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('epic','goal','task','ticket')),
        title TEXT NOT NULL, bodyMd TEXT NOT NULL DEFAULT '',
        manualStatus TEXT NOT NULL DEFAULT 'planned' CHECK (manualStatus IN ('icebox','planned','done')),
        sessionState TEXT NOT NULL DEFAULT 'none' CHECK (sessionState IN ('none','in-session','done-by-ticket')),
        remoteStatus TEXT, source TEXT NOT NULL CHECK (source IN ('manual','agent','linear','generated')),
        parentId TEXT, linearId TEXT, linearUrl TEXT, contentHash TEXT,
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_backlog_project_status ON backlog_items(projectId, manualStatus);
      CREATE INDEX IF NOT EXISTS idx_backlog_parent ON backlog_items(parentId);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_backlog_linear ON backlog_items(projectId, linearId) WHERE linearId IS NOT NULL;

      CREATE TABLE IF NOT EXISTS session_backlog (
        sessionId TEXT NOT NULL, itemId TEXT NOT NULL, PRIMARY KEY (sessionId, itemId)
      );
      CREATE INDEX IF NOT EXISTS idx_session_backlog_item ON session_backlog(itemId);

      -- v2 queue (P0.B + R8/R9/R11/R38). ordering index (projectId,state,position,id).
      CREATE TABLE IF NOT EXISTS session_queue (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, objective TEXT NOT NULL,
        provider TEXT NOT NULL, model TEXT NOT NULL, useContainer INTEGER NOT NULL DEFAULT 0,
        taskKind TEXT, taskSubkind TEXT, agentRelPath TEXT, backlogItemIds TEXT NOT NULL DEFAULT '[]',
        position INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','launching','launched','failed')),
        attempts INTEGER NOT NULL DEFAULT 0, launchedSessionId TEXT, lastError TEXT,
        leaseToken TEXT, ownerBootId TEXT, claimedAt INTEGER, createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_queue_order ON session_queue(projectId, state, position, id);

      -- v2 snapshots (schema frozen; capture deferred — SNAPSHOT scope decision).
      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, sessionId TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('baseline','recovery')),
        indexTreeSha TEXT NOT NULL, workTreeSha TEXT NOT NULL, commitSha TEXT NOT NULL,
        createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_project ON snapshots(projectId, createdAt);

      -- v2 review write-ahead log (R22/R23): durable trust metadata so review
      -- (Linear/handoff) text can never be auto-resubmitted from history.
      CREATE TABLE IF NOT EXISTS session_review_log (
        id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, insertedAt INTEGER NOT NULL,
        contentHash TEXT NOT NULL, normalizedText TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_review_session ON session_review_log(sessionId);

      -- v2 FTS (P0.B, C-9): external-content tables mirror transcripts + backlog.
      CREATE VIRTUAL TABLE IF NOT EXISTS transcripts_fts USING fts5(
        chunk, content='transcripts', content_rowid='rowid'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS backlog_fts USING fts5(
        title, bodyMd, content='backlog_items', content_rowid='rowid'
      );
    `)
    this.migrateProjectIds() // B7: upgrade legacy kebab ids to durable hash ids
    this.migrateSessionTaskColumns() // M-LOG-a: add task label columns (additive)
    this.migrateSessionV2Columns() // v2: desired/applied/termState/version columns
    this.migrateTicketsToBacklog() // v2: one-time tickets → backlog_items (C-7)
    this.rebuildFtsIfEmpty() // v2: populate FTS from existing content on upgrade
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

  /** v2: additive desired/applied/termState/version columns + R29 backfill.
   *  Existing rows get behavior-preserving defaults (legacy container sessions
   *  were already backfilled stage='fix', so their auto-approve is unchanged). */
  migrateSessionV2Columns(): void {
    const cols = new Set(
      (this.db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]).map((c) => c.name)
    )
    const add = (name: string, ddl: string) => { if (!cols.has(name)) this.db.exec(`ALTER TABLE sessions ADD COLUMN ${ddl}`) }
    const fresh = !cols.has('desiredStage')
    add('desiredStage', 'desiredStage TEXT')
    add('desiredProvider', 'desiredProvider TEXT')
    add('desiredModel', 'desiredModel TEXT')
    add('effectiveStage', 'effectiveStage TEXT')
    add('spawnedProvider', 'spawnedProvider TEXT')
    add('spawnedModel', 'spawnedModel TEXT')
    add('spawnedApprovalMode', 'spawnedApprovalMode TEXT')
    add('termState', 'termState TEXT')
    add('runtimeVersion', 'runtimeVersion INTEGER')
    add('desiredVersion', 'desiredVersion INTEGER')
    add('agentRelPath', 'agentRelPath TEXT')
    add('costJson', 'costJson TEXT')
    if (fresh) {
      // R29-2 backfill: desired=effective=COALESCE(legacy stage,'fix'); provider/
      // model mirror both sides; approval mode derived from useContainer+fix.
      this.db.exec(`
        UPDATE sessions SET
          desiredStage    = 'fix',
          effectiveStage  = 'fix',
          desiredProvider = provider,
          spawnedProvider = provider,
          desiredModel    = model,
          spawnedModel    = model,
          spawnedApprovalMode = CASE WHEN useContainer = 1 THEN 'auto' ELSE 'guarded' END,
          termState       = 'terminated',
          runtimeVersion  = 0,
          desiredVersion  = 0
        WHERE desiredStage IS NULL
      `)
    }
  }

  /** v2 (C-7): one-time copy of existing tickets into backlog_items so the
   *  Backlog tab reads a single table. Idempotent: keyed on 'bl-'+ticketId. */
  migrateTicketsToBacklog(): void {
    const rows = this.db.prepare(`SELECT id, projectId, subkind, title, bodyMd, createdAt FROM tickets`).all() as
      { id: string; projectId: string; subkind: string; title: string; bodyMd: string; createdAt: number }[]
    const upsert = this.db.transaction((items: typeof rows) => {
      for (const t of items) this.upsertGeneratedBacklogItem({
        blId: 'bl-' + t.id, projectId: t.projectId, title: t.title, bodyMd: t.bodyMd,
        contentHash: sha256(t.bodyMd), createdAt: t.createdAt
      })
    })
    upsert(rows)
  }

  /** Populate FTS from existing content when the virtual tables are empty (an
   *  upgrade of a pre-v2 DB that already has transcripts/backlog rows). */
  rebuildFtsIfEmpty(): void {
    const has = (t: string) => (this.db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c > 0
    if (!has('transcripts_fts') && has('transcripts')) this.db.exec(`INSERT INTO transcripts_fts(transcripts_fts) VALUES('rebuild')`)
    if (!has('backlog_fts') && has('backlog_items')) this.db.exec(`INSERT INTO backlog_fts(backlog_fts) VALUES('rebuild')`)
  }

  saveSession(s: Session): void {
    // Recompute bound-item status if this write crosses the running boundary (R9-3).
    const wasActive = this.isSessionActive(s.id)
    this.db
      .prepare(
        `INSERT INTO sessions (id,projectId,provider,model,objective,status,createdAt,updatedAt,taskKind,taskSubkind,taskStatus,useContainer,
           desiredStage,desiredProvider,desiredModel,effectiveStage,spawnedProvider,spawnedModel,spawnedApprovalMode,termState,runtimeVersion,desiredVersion,agentRelPath,costJson)
         VALUES (@id,@projectId,@provider,@model,@objective,@status,@createdAt,@updatedAt,@taskKind,@taskSubkind,@taskStatus,@uc,
           @desiredStage,@desiredProvider,@desiredModel,@effectiveStage,@spawnedProvider,@spawnedModel,@spawnedApprovalMode,@termState,@runtimeVersion,@desiredVersion,@agentRelPath,@costJson)
         ON CONFLICT(id) DO UPDATE SET status=@status, provider=@provider, model=@model, objective=@objective, updatedAt=@updatedAt,
           taskKind=@taskKind, taskSubkind=@taskSubkind, taskStatus=@taskStatus, useContainer=@uc,
           desiredStage=@desiredStage, desiredProvider=@desiredProvider, desiredModel=@desiredModel, effectiveStage=@effectiveStage,
           spawnedProvider=@spawnedProvider, spawnedModel=@spawnedModel, spawnedApprovalMode=@spawnedApprovalMode,
           termState=@termState, runtimeVersion=@runtimeVersion, desiredVersion=@desiredVersion, agentRelPath=@agentRelPath, costJson=@costJson`
      )
      .run({
        ...s,
        taskKind: s.taskKind ?? null,
        taskSubkind: s.taskSubkind ?? null,
        taskStatus: s.taskStatus ?? null,
        uc: s.useContainer == null ? null : s.useContainer ? 1 : 0,
        desiredStage: s.desiredStage ?? null,
        desiredProvider: s.desiredProvider ?? null,
        desiredModel: s.desiredModel ?? null,
        effectiveStage: s.effectiveStage ?? null,
        spawnedProvider: s.spawnedProvider ?? null,
        spawnedModel: s.spawnedModel ?? null,
        spawnedApprovalMode: s.spawnedApprovalMode ?? null,
        termState: s.termState ?? null,
        runtimeVersion: s.runtimeVersion ?? null,
        desiredVersion: s.desiredVersion ?? null,
        agentRelPath: s.agentRelPath ?? null,
        costJson: s.cost ? JSON.stringify(s.cost) : null
      })
    if (wasActive !== ACTIVE_STATUSES.has(s.status)) this.recomputeItemsForSession(s.id)
  }

  /** SQLite stores useContainer as 0/1/NULL; the app type is boolean | null. */
  private static rowToSession(r: any): Session {
    return {
      ...r,
      useContainer: r.useContainer == null ? null : !!r.useContainer,
      cost: r.costJson ? JSON.parse(r.costJson) : null
    }
  }

  private isSessionActive(id: string): boolean {
    const r = this.db.prepare(`SELECT status FROM sessions WHERE id = ?`).get(id) as { status: SessionStatus } | undefined
    return !!r && ACTIVE_STATUSES.has(r.status)
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

  /** Persist a ticket, advance its session to 'ticketed', AND upsert the mirror
   *  backlog row (C-7) — all in ONE transaction. Also marks any backlog items
   *  bound to this session as done-by-ticket (recompute). */
  finalizeTicket(t: Ticket): void {
    this.db.transaction(() => {
      this.saveTicket(t)
      this.setTaskStatus(t.sessionId, 'ticketed')
      this.upsertGeneratedBacklogItem({
        blId: 'bl-' + t.id, projectId: t.projectId, title: t.title, bodyMd: t.bodyMd,
        contentHash: sha256(t.bodyMd), createdAt: t.createdAt
      })
      this.recomputeItemsForSession(t.sessionId)
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

  /** Legacy archive (kept for the existing simple close path). For the queue-safe
   *  path use archiveSessionGuarded, which the launchService gate holds. */
  archiveSession(id: string): void {
    const wasActive = this.isSessionActive(id)
    this.db.prepare(`UPDATE sessions SET status = 'archived' WHERE id = ?`).run(id)
    if (wasActive) this.recomputeItemsForSession(id)
  }

  /** Guarded archive transition (R3-3/R37/R38): archives ONLY on a real
   *  non-archived→archived transition, CAS on runtimeVersion (bumped), and
   *  recomputes bound items in the same transaction. Returns whether it changed. */
  archiveSessionGuarded(id: string, expectRuntimeVersion: number): boolean {
    return this.db.transaction(() => {
      const info = this.db.prepare(
        `UPDATE sessions SET status='archived', termState='terminated', runtimeVersion=runtimeVersion+1
         WHERE id=? AND status!='archived' AND runtimeVersion=?`
      ).run(id, expectRuntimeVersion)
      const changed = info.changes === 1
      if (changed) this.recomputeItemsForSession(id)
      return changed
    })()
  }

  renameSession(id: string, name: string): void {
    this.db.prepare(`UPDATE sessions SET objective = ? WHERE id = ?`).run(name, id)
  }

  setSessionStatus(id: string, status: SessionStatus): void {
    const wasActive = this.isSessionActive(id)
    this.db.prepare(`UPDATE sessions SET status = ? WHERE id = ?`).run(status, id)
    if (wasActive !== ACTIVE_STATUSES.has(status)) this.recomputeItemsForSession(id)
  }

  /** Bump a session's runtimeVersion (R38) — used by gated runtime transitions. */
  bumpRuntimeVersion(id: string): number {
    const r = this.db.prepare(
      `UPDATE sessions SET runtimeVersion = COALESCE(runtimeVersion,0)+1 WHERE id=? RETURNING runtimeVersion`
    ).get(id) as { runtimeVersion: number } | undefined
    return r?.runtimeVersion ?? 0
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
    // FTS external-content: mirror each inserted rowid into transcripts_fts so
    // search stays in sync inside the same transaction (C-9).
    const ftsInsert = this.db.prepare(`INSERT INTO transcripts_fts(rowid, chunk) VALUES (?, ?)`)
    const writeAll = this.db.transaction((rows: typeof batch) => {
      for (const r of rows) {
        const info = insert.run(r)
        ftsInsert.run(info.lastInsertRowid, r.chunk)
      }
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

  // ===================== v2 Backlog ========================================

  private static rowToBacklog(r: any): BacklogItem {
    return { ...r }
  }

  getBacklogItem(id: string): BacklogItem | undefined {
    const r = this.db.prepare(`SELECT * FROM backlog_items WHERE id = ?`).get(id)
    return r ? Store.rowToBacklog(r) : undefined
  }

  listBacklog(projectId: string): BacklogItem[] {
    return this.db.prepare(`SELECT * FROM backlog_items WHERE projectId = ? ORDER BY createdAt`).all(projectId).map(Store.rowToBacklog)
  }

  /** Effective status for board placement/lifecycle (R34). */
  backlogEffectiveStatus(id: string): BacklogEffectiveStatus | undefined {
    const i = this.getBacklogItem(id)
    return i ? effectiveStatus(i) : undefined
  }

  /** Create a MANUAL backlog item (R17). Main forces source='manual'; provenance
   *  fields are never accepted from the renderer. Validates hierarchy (C-8). */
  createBacklogItem(input: BacklogCreateInput): { item?: BacklogItem; error?: string } {
    if (!input.title?.trim()) return { error: 'title required' }
    if (input.parentId) {
      const parent = this.getBacklogItem(input.parentId)
      if (!parent) return { error: 'parent not found' }
      if (parent.projectId !== input.projectId) return { error: 'parent in a different project' }
      if (!canNest(parent.kind, input.kind)) return { error: `a ${parent.kind} cannot contain a ${input.kind}` }
    }
    const now = Date.now()
    const item: BacklogItem = {
      id: 'bl-' + randomUUID(), projectId: input.projectId, kind: input.kind,
      title: input.title.trim(), bodyMd: input.bodyMd ?? '',
      manualStatus: input.manualStatus ?? 'planned', sessionState: 'none',
      remoteStatus: null, source: 'manual', parentId: input.parentId ?? null,
      linearId: null, linearUrl: null, contentHash: null, createdAt: now, updatedAt: now
    }
    this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO backlog_items (id,projectId,kind,title,bodyMd,manualStatus,sessionState,remoteStatus,source,parentId,linearId,linearUrl,contentHash,createdAt,updatedAt)
         VALUES (@id,@projectId,@kind,@title,@bodyMd,@manualStatus,@sessionState,@remoteStatus,@source,@parentId,@linearId,@linearUrl,@contentHash,@createdAt,@updatedAt)`
      ).run(item)
      const rowid = this.db.prepare(`SELECT rowid FROM backlog_items WHERE id=?`).pluck().get(item.id) as number
      this.db.prepare(`INSERT INTO backlog_fts(rowid, title, bodyMd) VALUES(?, ?, ?)`).run(rowid, item.title, item.bodyMd)
    })()
    return { item }
  }

  /** Update a manual/agent backlog item through the generic path (R17): refuses
   *  linear/generated rows; only title/bodyMd/manualStatus/parentId are writable. */
  updateBacklogItem(input: BacklogUpdateInput): { item?: BacklogItem; error?: string } {
    const existing = this.getBacklogItem(input.id)
    if (!existing) return { error: 'item not found' }
    if (existing.source === 'linear' || existing.source === 'generated') return { error: `${existing.source} items are read-only` }
    if (input.parentId !== undefined && input.parentId !== null) {
      const parent = this.getBacklogItem(input.parentId)
      if (!parent) return { error: 'parent not found' }
      if (parent.projectId !== existing.projectId) return { error: 'parent in a different project' }
      if (input.parentId === input.id) return { error: 'an item cannot be its own parent' }
      if (this.wouldCycle(input.id, input.parentId)) return { error: 'that parent would create a cycle' }
      if (!canNest(parent.kind, existing.kind)) return { error: `a ${parent.kind} cannot contain a ${existing.kind}` }
    }
    const next = {
      title: input.title ?? existing.title,
      bodyMd: input.bodyMd ?? existing.bodyMd,
      manualStatus: input.manualStatus ?? existing.manualStatus,
      parentId: input.parentId === undefined ? existing.parentId : input.parentId,
      updatedAt: Date.now(), id: input.id
    }
    this.db.transaction(() => {
      this.db.prepare(
        `UPDATE backlog_items SET title=@title, bodyMd=@bodyMd, manualStatus=@manualStatus, parentId=@parentId, updatedAt=@updatedAt WHERE id=@id`
      ).run(next)
      const rowid = this.db.prepare(`SELECT rowid FROM backlog_items WHERE id=?`).pluck().get(input.id) as number
      this.db.prepare(`INSERT INTO backlog_fts(backlog_fts, rowid, title, bodyMd) VALUES('delete', ?, ?, ?)`).run(rowid, existing.title, existing.bodyMd)
      this.db.prepare(`INSERT INTO backlog_fts(rowid, title, bodyMd) VALUES(?, ?, ?)`).run(rowid, next.title, next.bodyMd)
    })()
    return { item: this.getBacklogItem(input.id) }
  }

  /** Delete a manual/agent item: refused while any bound session is active
   *  (R19-4); children re-parent to the deleted node's parent (C-8); FTS +
   *  session_backlog joins removed transactionally. */
  deleteBacklogItem(id: string): { ok?: true; error?: string } {
    const existing = this.getBacklogItem(id)
    if (!existing) return { error: 'item not found' }
    if (existing.source === 'linear' || existing.source === 'generated') return { error: `${existing.source} items are read-only` }
    if (this.hasActiveBoundSession(id)) return { error: 'cannot delete: an active session is bound to this item' }
    this.db.transaction(() => {
      const rowid = this.db.prepare(`SELECT rowid FROM backlog_items WHERE id=?`).pluck().get(id) as number
      this.db.prepare(`UPDATE backlog_items SET parentId=? WHERE parentId=?`).run(existing.parentId ?? null, id)
      this.db.prepare(`DELETE FROM session_backlog WHERE itemId=?`).run(id)
      this.db.prepare(`INSERT INTO backlog_fts(backlog_fts, rowid, title, bodyMd) VALUES('delete', ?, ?, ?)`).run(rowid, existing.title, existing.bodyMd)
      this.db.prepare(`DELETE FROM backlog_items WHERE id=?`).run(id)
    })()
    return { ok: true }
  }

  private wouldCycle(id: string, newParentId: string): boolean {
    let cur: string | null | undefined = newParentId
    const seen = new Set<string>()
    while (cur) {
      if (cur === id) return true
      if (seen.has(cur)) return true
      seen.add(cur)
      cur = this.db.prepare(`SELECT parentId FROM backlog_items WHERE id=?`).pluck().get(cur) as string | null | undefined
    }
    return false
  }

  private hasActiveBoundSession(itemId: string): boolean {
    const rows = this.db.prepare(
      `SELECT s.status FROM session_backlog sb JOIN sessions s ON s.id = sb.sessionId WHERE sb.itemId = ?`
    ).all(itemId) as { status: SessionStatus }[]
    return rows.some((r) => ACTIVE_STATUSES.has(r.status))
  }

  // --- source-authority-restricted writers (never the generic CRUD, R17) ---

  /** Insert/update a generated (ticket-mirror) backlog item. Whitelisted fields
   *  only; source is always 'generated'. */
  upsertGeneratedBacklogItem(a: { blId: string; projectId: string; title: string; bodyMd: string; contentHash: string; createdAt: number }): void {
    const now = Date.now()
    const existing = this.getBacklogItem(a.blId)
    this.db.prepare(
      `INSERT INTO backlog_items (id,projectId,kind,title,bodyMd,manualStatus,sessionState,remoteStatus,source,parentId,linearId,linearUrl,contentHash,createdAt,updatedAt)
       VALUES (@id,@projectId,'ticket',@title,@bodyMd,'done','none',NULL,'generated',NULL,NULL,NULL,@contentHash,@createdAt,@updatedAt)
       ON CONFLICT(id) DO UPDATE SET title=@title, bodyMd=@bodyMd, contentHash=@contentHash, updatedAt=@updatedAt`
    ).run({ id: a.blId, projectId: a.projectId, title: a.title, bodyMd: a.bodyMd, contentHash: a.contentHash, createdAt: a.createdAt, updatedAt: now })
    const rowid = this.db.prepare(`SELECT rowid FROM backlog_items WHERE id=?`).pluck().get(a.blId) as number
    if (existing) this.db.prepare(`INSERT INTO backlog_fts(backlog_fts, rowid, title, bodyMd) VALUES('delete', ?, ?, ?)`).run(rowid, existing.title, existing.bodyMd)
    this.db.prepare(`INSERT INTO backlog_fts(rowid, title, bodyMd) VALUES(?, ?, ?)`).run(rowid, a.title, a.bodyMd)
  }

  /** Ingest an agent-created inbox item (S1): source='agent', whitelisted fields,
   *  dedupe by contentHash within the project (transactional, R21). Returns the
   *  created item or null if a duplicate hash already exists. */
  ingestAgentBacklogItem(a: { projectId: string; kind: BacklogKind; title: string; bodyMd: string; parentId?: string | null; contentHash: string }): BacklogItem | null {
    return this.db.transaction(() => {
      const dup = this.db.prepare(`SELECT id FROM backlog_items WHERE projectId=? AND contentHash=?`).get(a.projectId, a.contentHash)
      if (dup) return null
      const now = Date.now()
      const id = 'bl-' + randomUUID()
      this.db.prepare(
        `INSERT INTO backlog_items (id,projectId,kind,title,bodyMd,manualStatus,sessionState,remoteStatus,source,parentId,linearId,linearUrl,contentHash,createdAt,updatedAt)
         VALUES (@id,@projectId,@kind,@title,@bodyMd,'planned','none',NULL,'agent',@parentId,NULL,NULL,@contentHash,@now,@now)`
      ).run({ id, projectId: a.projectId, kind: a.kind, title: a.title, bodyMd: a.bodyMd, parentId: a.parentId ?? null, contentHash: a.contentHash, now })
      const rowid = this.db.prepare(`SELECT rowid FROM backlog_items WHERE id=?`).pluck().get(id) as number
      this.db.prepare(`INSERT INTO backlog_fts(rowid, title, bodyMd) VALUES(?, ?, ?)`).run(rowid, a.title, a.bodyMd)
      return this.getBacklogItem(id)!
    })()
  }

  /** Upsert a Linear-pulled item (S2): source='linear', keyed on (projectId,
   *  linearId); writes remoteStatus but NEVER the local manualStatus/sessionState. */
  upsertLinearBacklogItem(a: { projectId: string; linearId: string; linearUrl: string; title: string; bodyMd: string; remoteStatus: string }): void {
    const existing = this.db.prepare(`SELECT id, title, bodyMd FROM backlog_items WHERE projectId=? AND linearId=?`).get(a.projectId, a.linearId) as { id: string; title: string; bodyMd: string } | undefined
    const now = Date.now()
    if (existing) {
      this.db.prepare(`UPDATE backlog_items SET title=?, bodyMd=?, linearUrl=?, remoteStatus=?, updatedAt=? WHERE id=?`)
        .run(a.title, a.bodyMd, a.linearUrl, a.remoteStatus, now, existing.id)
      const rowid = this.db.prepare(`SELECT rowid FROM backlog_items WHERE id=?`).pluck().get(existing.id) as number
      this.db.prepare(`INSERT INTO backlog_fts(backlog_fts, rowid, title, bodyMd) VALUES('delete', ?, ?, ?)`).run(rowid, existing.title, existing.bodyMd)
      this.db.prepare(`INSERT INTO backlog_fts(rowid, title, bodyMd) VALUES(?, ?, ?)`).run(rowid, a.title, a.bodyMd)
      return
    }
    const id = 'bl-' + randomUUID()
    this.db.prepare(
      `INSERT INTO backlog_items (id,projectId,kind,title,bodyMd,manualStatus,sessionState,remoteStatus,source,parentId,linearId,linearUrl,contentHash,createdAt,updatedAt)
       VALUES (@id,@projectId,'task',@title,@bodyMd,'planned','none',@remoteStatus,'linear',NULL,@linearId,@linearUrl,NULL,@now,@now)`
    ).run({ id, projectId: a.projectId, title: a.title, bodyMd: a.bodyMd, remoteStatus: a.remoteStatus, linearId: a.linearId, linearUrl: a.linearUrl, now })
    const rowid = this.db.prepare(`SELECT rowid FROM backlog_items WHERE id=?`).pluck().get(id) as number
    this.db.prepare(`INSERT INTO backlog_fts(rowid, title, bodyMd) VALUES(?, ?, ?)`).run(rowid, a.title, a.bodyMd)
  }

  // --- session ↔ backlog binding + status recomputation (R9-3/R34) ---

  bindSessionBacklog(sessionId: string, itemIds: string[]): void {
    this.db.transaction(() => {
      const ins = this.db.prepare(`INSERT OR IGNORE INTO session_backlog (sessionId, itemId) VALUES (?, ?)`)
      for (const itemId of itemIds) { ins.run(sessionId, itemId); this.recomputeItemStatus(itemId) }
    })()
  }

  unbindSessionBacklog(sessionId: string, itemId: string): void {
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM session_backlog WHERE sessionId=? AND itemId=?`).run(sessionId, itemId)
      this.recomputeItemStatus(itemId)
    })()
  }

  itemsForSession(sessionId: string): string[] {
    return this.db.prepare(`SELECT itemId FROM session_backlog WHERE sessionId=?`).pluck().all(sessionId) as string[]
  }

  /** Recompute one item's sessionState from its bound sessions (R34):
   *  done-by-ticket if any bound session is ticketed; else in-session if any is
   *  active ({starting,running}); else none. */
  recomputeItemStatus(itemId: string): void {
    const rows = this.db.prepare(
      `SELECT s.status, s.taskStatus FROM session_backlog sb JOIN sessions s ON s.id=sb.sessionId WHERE sb.itemId=?`
    ).all(itemId) as { status: SessionStatus; taskStatus: string | null }[]
    let next: BacklogItem['sessionState'] = 'none'
    if (rows.some((r) => r.taskStatus === 'ticketed')) next = 'done-by-ticket'
    else if (rows.some((r) => ACTIVE_STATUSES.has(r.status))) next = 'in-session'
    this.db.prepare(`UPDATE backlog_items SET sessionState=?, updatedAt=? WHERE id=?`).run(next, Date.now(), itemId)
  }

  /** Recompute every item bound to a session (called on running-boundary crossings). */
  recomputeItemsForSession(sessionId: string): void {
    for (const itemId of this.itemsForSession(sessionId)) this.recomputeItemStatus(itemId)
  }

  // ===================== v2 Queue (R8/R9/R11/R38) ==========================

  private static rowToQueue(r: any): QueueItem {
    return { ...r, useContainer: !!r.useContainer, backlogItemIds: JSON.parse(r.backlogItemIds || '[]') }
  }

  listQueue(projectId: string): QueueItem[] {
    return this.db.prepare(`SELECT * FROM session_queue WHERE projectId=? ORDER BY position, id`).all(projectId).map(Store.rowToQueue)
  }

  getQueueItem(id: string): QueueItem | undefined {
    const r = this.db.prepare(`SELECT * FROM session_queue WHERE id=?`).get(id)
    return r ? Store.rowToQueue(r) : undefined
  }

  enqueue(input: Omit<QueueItem, 'id' | 'position' | 'state' | 'attempts' | 'createdAt' | 'launchedSessionId' | 'lastError' | 'leaseToken' | 'ownerBootId' | 'claimedAt'>): QueueItem {
    const now = Date.now()
    const maxPos = (this.db.prepare(`SELECT COALESCE(MAX(position),-1) m FROM session_queue WHERE projectId=?`).get(input.projectId) as { m: number }).m
    const item: QueueItem = { ...input, id: 'q-' + randomUUID(), position: maxPos + 1, state: 'pending', attempts: 0, createdAt: now }
    this.db.prepare(
      `INSERT INTO session_queue (id,projectId,objective,provider,model,useContainer,taskKind,taskSubkind,agentRelPath,backlogItemIds,position,state,attempts,createdAt)
       VALUES (@id,@projectId,@objective,@provider,@model,@uc,@taskKind,@taskSubkind,@agentRelPath,@backlogItemIds,@position,'pending',0,@createdAt)`
    ).run({ ...item, uc: item.useContainer ? 1 : 0, taskKind: item.taskKind ?? null, taskSubkind: item.taskSubkind ?? null, agentRelPath: item.agentRelPath ?? null, backlogItemIds: JSON.stringify(item.backlogItemIds) })
    return item
  }

  deleteQueueItem(id: string): void { this.db.prepare(`DELETE FROM session_queue WHERE id=?`).run(id) }

  reorderQueue(projectId: string, orderedIds: string[]): void {
    this.db.transaction(() => {
      const upd = this.db.prepare(`UPDATE session_queue SET position=? WHERE id=? AND projectId=?`)
      orderedIds.forEach((id, i) => upd.run(i, id, projectId))
    })()
  }

  /** Atomically claim the oldest pending row for a project, but ONLY if the
   *  project has no in-flight 'launching' row (R8 no-overtaking). Stamps a fresh
   *  lease token + ownerBootId + claimedAt and bumps attempts. Returns the claimed
   *  row (with its lease) or null. */
  claimNextQueue(projectId: string, bootId: string): QueueItem | null {
    return this.db.transaction(() => {
      const inflight = this.db.prepare(`SELECT 1 FROM session_queue WHERE projectId=? AND state='launching' LIMIT 1`).get(projectId)
      if (inflight) return null
      const next = this.db.prepare(`SELECT id FROM session_queue WHERE projectId=? AND state='pending' ORDER BY position, id LIMIT 1`).pluck().get(projectId) as string | undefined
      if (!next) return null
      const lease = randomUUID()
      this.db.prepare(
        `UPDATE session_queue SET state='launching', leaseToken=?, ownerBootId=?, claimedAt=?, attempts=attempts+1 WHERE id=? AND state='pending'`
      ).run(lease, bootId, Date.now(), next)
      return this.getQueueItem(next) ?? null
    })()
  }

  /** R9-1 advancement precondition: no active session (starting/running) and no
   *  'launched' queue row still bound to a non-archived session, and no
   *  'launching' row. Checked inside the caller's serialized gate section. */
  canAdvanceQueue(projectId: string): boolean {
    const active = this.db.prepare(
      `SELECT 1 FROM sessions WHERE projectId=? AND status IN ('starting','running') LIMIT 1`
    ).get(projectId)
    if (active) return false
    const launching = this.db.prepare(`SELECT 1 FROM session_queue WHERE projectId=? AND state='launching' LIMIT 1`).get(projectId)
    if (launching) return false
    const interrupted = this.db.prepare(
      `SELECT 1 FROM session_queue q JOIN sessions s ON s.id=q.launchedSessionId
       WHERE q.projectId=? AND q.state='launched' AND s.status!='archived' LIMIT 1`
    ).get(projectId)
    return !interrupted
  }

  /** Mark a claimed row launched, binding its session, CAS on the lease (R4-2/R9-2). */
  markQueueLaunched(id: string, leaseToken: string, sessionId: string): boolean {
    return this.db.prepare(
      `UPDATE session_queue SET state='launched', launchedSessionId=?, leaseToken=NULL WHERE id=? AND state='launching' AND leaseToken=?`
    ).run(sessionId, id, leaseToken).changes === 1
  }

  markQueueFailed(id: string, leaseToken: string | null, error: string): void {
    if (leaseToken) this.db.prepare(`UPDATE session_queue SET state='failed', lastError=?, leaseToken=NULL WHERE id=? AND leaseToken=?`).run(error, id, leaseToken)
    else this.db.prepare(`UPDATE session_queue SET state='failed', lastError=?, leaseToken=NULL WHERE id=?`).run(error, id)
  }

  renewQueueLease(id: string, leaseToken: string): void {
    this.db.prepare(`UPDATE session_queue SET claimedAt=? WHERE id=? AND leaseToken=?`).run(Date.now(), id, leaseToken)
  }

  /** Boot reconciliation (R8/R12): 'launching' rows owned by a dead prior boot
   *  (ownerBootId != current) are re-pended if attempts<2, else failed. Pre-intent
   *  claims only — a committed intent leaves the queue row 'launched' (handled by
   *  session reconciliation, not here). */
  reconcileQueueOnBoot(currentBootId: string): void {
    this.db.transaction(() => {
      const stale = this.db.prepare(`SELECT id, attempts FROM session_queue WHERE state='launching' AND (ownerBootId IS NULL OR ownerBootId != ?)`).all(currentBootId) as { id: string; attempts: number }[]
      for (const r of stale) {
        if (r.attempts < 2) this.db.prepare(`UPDATE session_queue SET state='pending', leaseToken=NULL, ownerBootId=NULL, claimedAt=NULL WHERE id=?`).run(r.id)
        else this.db.prepare(`UPDATE session_queue SET state='failed', lastError='owner died', leaseToken=NULL WHERE id=?`).run(r.id)
      }
    })()
  }

  /** Watchdog (R9-2): this-boot 'launching' rows whose lease is stale beyond the
   *  bound are failed, fencing any hung async continuation. */
  failStaleClaims(currentBootId: string, olderThanMs: number): string[] {
    const cutoff = Date.now() - olderThanMs
    const stale = this.db.prepare(`SELECT id FROM session_queue WHERE state='launching' AND ownerBootId=? AND claimedAt < ?`).pluck().all(currentBootId, cutoff) as string[]
    for (const id of stale) this.db.prepare(`UPDATE session_queue SET state='failed', lastError='launch timed out', leaseToken=NULL WHERE id=?`).run(id)
    return stale
  }

  // ===================== v2 Review log (R22/R23) ===========================

  /** Write-ahead a review insertion BEFORE the pty write. Complete normalized
   *  payload, no size cap. If this throws, the caller must refuse the insertion. */
  logReviewInsertion(sessionId: string, normalizedText: string): void {
    this.db.prepare(`INSERT INTO session_review_log (id, sessionId, insertedAt, contentHash, normalizedText) VALUES (?, ?, ?, ?, ?)`)
      .run('rev-' + randomUUID(), sessionId, Date.now(), sha256(normalizedText), normalizedText)
  }

  reviewPayloadsForSession(sessionId: string): string[] {
    return this.db.prepare(`SELECT normalizedText FROM session_review_log WHERE sessionId=? ORDER BY insertedAt`).pluck().all(sessionId) as string[]
  }

  // ===================== v2 Snapshots (schema frozen) ======================

  saveSnapshot(s: Snapshot): void {
    this.db.prepare(
      `INSERT INTO snapshots (id,projectId,sessionId,kind,indexTreeSha,workTreeSha,commitSha,createdAt)
       VALUES (@id,@projectId,@sessionId,@kind,@indexTreeSha,@workTreeSha,@commitSha,@createdAt)`
    ).run({ ...s, sessionId: s.sessionId ?? null })
  }

  listSnapshots(projectId: string): Snapshot[] {
    return this.db.prepare(`SELECT * FROM snapshots WHERE projectId=? ORDER BY createdAt DESC`).all(projectId) as Snapshot[]
  }

  // ===================== v2 Search (FTS, C-9/C-10) =========================

  /** Merged transcript + backlog search (R10 union). Terms are escaped so
   *  arbitrary input can't error. bm25 order then rowid DESC. */
  search(query: string, limit = 50): SearchHit[] {
    this.flush()
    const q = ftsQuery(query)
    const hits: SearchHit[] = []
    try {
      const tr = this.db.prepare(
        `SELECT t.session_id AS sessionId, t.ts AS ts, snippet(transcripts_fts, 0, '[', ']', '…', 10) AS snippet, s.projectId AS projectId
         FROM transcripts_fts f JOIN transcripts t ON t.rowid = f.rowid JOIN sessions s ON s.id = t.session_id
         WHERE transcripts_fts MATCH ? ORDER BY bm25(transcripts_fts), t.rowid DESC LIMIT ?`
      ).all(q, limit) as { sessionId: string; ts: number; snippet: string; projectId: string }[]
      for (const r of tr) hits.push({ type: 'transcript', sessionId: r.sessionId, projectId: r.projectId, snippet: r.snippet, ts: r.ts })
    } catch { /* malformed FTS — return what we have */ }
    try {
      const bl = this.db.prepare(
        `SELECT b.id AS itemId, b.projectId AS projectId, b.title AS title, b.kind AS kind, b.manualStatus AS manualStatus, b.sessionState AS sessionState,
                snippet(backlog_fts, 1, '[', ']', '…', 10) AS snippet
         FROM backlog_fts f JOIN backlog_items b ON b.rowid = f.rowid
         WHERE backlog_fts MATCH ? ORDER BY bm25(backlog_fts), b.rowid DESC LIMIT ?`
      ).all(q, limit) as { itemId: string; projectId: string; title: string; kind: BacklogKind; manualStatus: BacklogManualStatus; sessionState: any; snippet: string }[]
      for (const r of bl) hits.push({ type: 'backlog', itemId: r.itemId, projectId: r.projectId, title: r.title, snippet: r.snippet, kind: r.kind, status: effectiveStatus({ manualStatus: r.manualStatus, sessionState: r.sessionState }) })
    } catch { /* malformed FTS */ }
    return hits
  }
}
