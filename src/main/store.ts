import Database from 'better-sqlite3'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'
import type { Project, Session, SessionStatus } from '@shared/types'

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
    `)
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

  saveSession(s: Session): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id,projectId,provider,model,objective,status,createdAt,updatedAt)
         VALUES (@id,@projectId,@provider,@model,@objective,@status,@createdAt,@updatedAt)
         ON CONFLICT(id) DO UPDATE SET status=@status, model=@model, objective=@objective, updatedAt=@updatedAt`
      )
      .run(s)
  }

  getSessions(projectId: string): Session[] {
    return this.db
      .prepare(`SELECT * FROM sessions WHERE projectId = ? ORDER BY createdAt`)
      .all(projectId) as Session[]
  }

  allSessions(): Session[] {
    return this.db.prepare(`SELECT * FROM sessions ORDER BY createdAt`).all() as Session[]
  }

  archiveSession(id: string): void {
    const status: SessionStatus = 'archived'
    this.db.prepare(`UPDATE sessions SET status = ? WHERE id = ?`).run(status, id)
  }

  renameSession(id: string, name: string): void {
    this.db.prepare(`UPDATE sessions SET objective = ? WHERE id = ?`).run(name, id)
  }

  setSessionStatus(id: string, status: SessionStatus): void {
    this.db.prepare(`UPDATE sessions SET status = ? WHERE id = ?`).run(status, id)
  }

  appendTranscript(sessionId: string, chunk: string, ts: number): void {
    this.db.prepare(`INSERT INTO transcripts (session_id,chunk,ts) VALUES (?,?,?)`).run(sessionId, chunk, ts)
  }

  /** Full transcript for a session, oldest→newest, optionally tail-capped to the
   *  last `maxBytes` characters so replaying a huge log into xterm on mount stays
   *  fast. The cap keeps the END (most recent output), trimmed to a line start so
   *  replay doesn't begin mid-escape-sequence. */
  getTranscript(sessionId: string, maxBytes = 256 * 1024): string {
    const full = (
      this.db
        .prepare(`SELECT chunk FROM transcripts WHERE session_id = ? ORDER BY ts, rowid`)
        .all(sessionId) as { chunk: string }[]
    )
      .map((r) => r.chunk)
      .join('')
    if (full.length <= maxBytes) return full
    const tail = full.slice(full.length - maxBytes)
    const nl = tail.indexOf('\n')
    return nl >= 0 ? tail.slice(nl + 1) : tail
  }
}
