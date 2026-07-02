import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync, writeFileSync } from 'node:fs'
import type { Session } from '@shared/types'
import { stripAnsi } from './history'
import { confinedPath } from './confine'
import type { Store } from './store'

// M-LOG-a (§4.3, D7): the IDE-owned per-project log. Only PRODUCT chats enter it;
// a raw entry is written when the chat is marked 'finished'. Layout:
//   <projectsRoot>/<projectId>/log/raw/<sessionId>.md   (ANSI-stripped + YAML front-matter)
// Git-committable via the B8 history repo mechanism, so user repos stay clean.

/** Root under which per-project logs live. AGENT_IDE_PROJECTS overrides for tests
 *  (mirrors historyDir()/libraryDir()). */
export function projectsLogRoot(): string {
  return process.env.AGENT_IDE_PROJECTS || join(homedir(), 'AgentIDE', 'projects')
}

/** The raw-log directory for a project (created on demand). */
export function projectRawLogDir(projectId: string): string {
  const dir = join(projectsLogRoot(), projectId, 'log', 'raw')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** The tickets directory for a project (created on demand). M-LOG-b (§4.3). */
export function projectTicketsDir(projectId: string): string {
  const dir = join(projectsLogRoot(), projectId, 'log', 'tickets')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** A filesystem-safe slug from a title (for the ticket filename). */
export function slugify(title: string): string {
  const s = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60)
  return s || 'ticket'
}

/** yyyy-mm-dd from an epoch-ms timestamp (UTC), for the ticket filename. */
export function dateStamp(createdAt: number): string {
  return new Date(createdAt).toISOString().slice(0, 10)
}

/** Write a generated ticket's Markdown to tickets/<date>-<slug>.md (§4.3),
 *  confined to the project's tickets dir. Returns the written path, or null on
 *  failure. */
export function writeTicketFile(projectId: string, title: string, bodyMd: string, createdAt: number): string | null {
  const dir = projectTicketsDir(projectId)
  const target = confinedPath(dir, `${dateStamp(createdAt)}-${slugify(title)}.md`)
  if (!target) return null
  try {
    writeFileSync(target, bodyMd, 'utf8')
    return target
  } catch {
    return null
  }
}

/** YAML front-matter for a raw log entry (§4.3): label, provider, model, dates,
 *  status. Values are simple scalars, so no escaping beyond wrapping the objective
 *  in quotes (it's free text). */
export function rawLogFrontmatter(session: Session, finishedAt: number): string {
  const q = (s: string) => JSON.stringify(s ?? '') // safe-quote free text
  return [
    '---',
    `session_id: ${session.id}`,
    `project_id: ${session.projectId}`,
    `objective: ${q(session.objective)}`,
    `task_kind: ${session.taskKind ?? ''}`,
    `task_subkind: ${session.taskSubkind ?? ''}`,
    `task_status: ${session.taskStatus ?? ''}`,
    `provider: ${session.provider}`,
    `model: ${session.model}`,
    `created_at: ${session.createdAt}`,
    `updated_at: ${session.updatedAt}`,
    `finished_at: ${finishedAt}`,
    '---',
    ''
  ].join('\n')
}

/** Write a product chat's raw log entry on 'finished' (§4.3). ANSI-stripped
 *  transcript + front-matter. Confined to the project's raw-log dir (a bad
 *  session id can't escape). Returns the written path, or null on failure /
 *  when there's nothing to write. `finishedAt` defaults to now but is injectable
 *  for deterministic tests. */
export function writeRawLog(store: Store, session: Session, finishedAt: number = Date.now()): string | null {
  const dir = projectRawLogDir(session.projectId)
  const target = confinedPath(dir, `${session.id}.md`)
  if (!target) return null // session id would escape the log dir — refuse
  const transcript = stripAnsi(store.getTranscript(session.id)).trim()
  const body = rawLogFrontmatter(session, finishedAt) + (transcript || '_(no transcript captured)_') + '\n'
  try {
    writeFileSync(target, body, 'utf8')
    return target
  } catch {
    return null
  }
}
