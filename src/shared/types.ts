export const PROVIDERS = ['codex', 'claude', 'gemini'] as const
export type Provider = typeof PROVIDERS[number]

export function isProvider(x: string): x is Provider {
  return (PROVIDERS as readonly string[]).includes(x)
}

/** A plain-shell session (no agent) is identified by its id prefix. */
export function isTerminalSession(id: string): boolean {
  return id.startsWith('term-')
}

export type SessionStatus = 'running' | 'idle' | 'archived'

// M-LOG (§4.1): every agent chat is one labeled task. `kind` routes it — only
// `product` chats enter the per-project log; `analysis` chats stay saved but
// produce no log. `subkind` applies to product chats only. Plain terminals
// (term-/login-) are unlabeled (all task_* null).
export type TaskKind = 'product' | 'analysis'
export type TaskSubkind = 'code' | 'feature' | 'bug'
// M-LOG task lifecycle (§4.1): open → finished (work done in-chat) → deployed
// (user confirms shipped) → ticketed (addendum pass wrote a ticket — M-LOG-b).
export type TaskStatus = 'open' | 'finished' | 'deployed' | 'ticketed'

export interface Model {
  id: string
  label: string
  tier: 'fast' | 'balanced' | 'max'
}

export interface Session {
  id: string
  projectId: string
  provider: Provider
  model: string
  objective: string
  status: SessionStatus
  createdAt: number
  updatedAt: number
  // M-LOG labels (null for terminals and grandfathered pre-M-LOG sessions).
  taskKind?: TaskKind | null
  taskSubkind?: TaskSubkind | null
  taskStatus?: TaskStatus | null
}

export interface Project {
  id: string
  name: string
  repo: string // owner/name
  localPath: string
  hasDevcontainer: boolean
}

// M-LOG-b (§4.4): the schema-constrained fields the addendum pass must produce
// from a deployed product chat's transcript. Validated in main; a single JSON
// object is demanded from the headless CLI.
export interface TicketFields {
  title: string
  subkind: TaskSubkind
  problem: string
  solution: string
  files_touched: string[]
  key_decisions: string[]
  follow_ups: string[]
  test_status: string
  deploy_ref: string
}

/** A generated roadmap ticket (§4.2 tickets table): rendered body_md + the
 *  schema-validated source fields, one row per ticketed task. */
export interface Ticket {
  id: string
  sessionId: string
  projectId: string
  subkind: TaskSubkind
  title: string
  bodyMd: string
  fieldsJson: string // JSON.stringify(TicketFields)
  createdAt: number
}

/** A library item — a Prompt, Skill, or Workflow read from the GitHub-backed
 *  library folder. `relPath` is the item's path relative to the library root
 *  (used for confined reads); `path` is the absolute path for display/debug. */
export type LibraryCategory = 'prompts' | 'skills' | 'workflows'

export interface LibraryItem {
  category: LibraryCategory
  name: string
  description: string
  relPath: string
  path: string
}

export interface LibraryContents {
  prompts: LibraryItem[]
  skills: LibraryItem[]
  workflows: LibraryItem[]
}
