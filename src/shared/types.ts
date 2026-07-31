export const PROVIDERS = ['codex', 'claude', 'gemini'] as const
export type Provider = (typeof PROVIDERS)[number]

export function isProvider(x: string): x is Provider {
  return (PROVIDERS as readonly string[]).includes(x)
}

/** A plain-shell session (no agent) is identified by its id prefix. */
export function isTerminalSession(id: string): boolean {
  return id.startsWith('term-')
}

// v2: 'starting' is the durable pre-spawn reservation (R10/R35) — a row exists
// and the runtime is reserved, but the pty may not have been promoted to running
// yet. Boot reconciliation resolves stale 'starting'/'running' rows without a
// live pty (host → idle; container → uncertain, R33/R36).
export type SessionStatus = 'starting' | 'running' | 'idle' | 'archived'

// v2 session-driven development harness (docs/plans/v2-backlog-harness-PLAN.md).
/** Discussion → Playback → Fix protocol stage. Auto-approve (container yolo
 *  flags) unlocks only at 'fix' (P0.A). Adjacent-only transitions. */
export type SessionStage = 'discussion' | 'playback' | 'fix'
/** The approval mode the LIVE pty was actually spawned with (R29). Changes only
 *  at promotion; label-only stage moves never touch it. */
export type ApprovalMode = 'guarded' | 'auto'
/** In-container termination lifecycle (R32-R36). Only container sessions can
 *  leave an orphan, so only they carry uncertainty; host sessions die with the
 *  app. 'spawning' is the pre-spawn reservation that fences a crash-created
 *  orphan; a replacement/resume spawn requires 'terminated'. */
export type TermState = 'spawning' | 'live' | 'terminating' | 'terminated' | 'uncertain'

// M-LOG (§4.1): every agent chat is one labeled task. `kind` routes it — only
// `product` chats enter the per-project log; `analysis` chats stay saved but
// produce no log. `subkind` applies to product chats only. Plain terminals
// (term-/login-) are unlabeled (all task_* null).
export type TaskKind = 'product' | 'analysis'
export type TaskSubkind = 'code' | 'feature' | 'bug'
// M-LOG task lifecycle (§4.1): open → finished (work done in-chat) → deployed
// (user confirms shipped) → ticketed (addendum pass wrote a ticket — M-LOG-b).
export type TaskStatus = 'open' | 'finished' | 'deployed' | 'ticketed'

/** Reasoning effort for a session. The provider CLIs each read their own config
 *  file when no flag is passed (e.g. Codex's ~/.codex/config.toml
 *  `model_reasoning_effort`), so an explicit level here is what lets a per-session
 *  choice WIN over that file — see launchArgv in ./main/providers.ts. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof EFFORTS)[number]

export function isEffort(x: string): x is Effort {
  return (EFFORTS as readonly string[]).includes(x)
}

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
  /** Execution context the session was launched in (host vs devcontainer).
   *  Persisted so resume/health checks recover it after an app restart; null
   *  for terminals, logins, and grandfathered rows. */
  useContainer?: boolean | null
  // --- v2 harness (docs/plans/v2-backlog-harness-PLAN.md) ---
  /** The user's DESIRED config (R28). Declarative writes set these; reconcile
   *  converges the live pty to them. null for legacy/terminal rows. */
  desiredStage?: SessionStage | null
  desiredProvider?: Provider | null
  desiredModel?: string | null
  /** The APPLIED config — the exact tuple the live pty was spawned with (R29).
   *  Written only at promotion; label-only stage moves never touch spawned*. */
  effectiveStage?: SessionStage | null
  spawnedProvider?: Provider | null
  spawnedModel?: string | null
  spawnedApprovalMode?: ApprovalMode | null
  /** Confirmed-termination lifecycle for container orphan safety (R33-R36). */
  termState?: TermState | null
  /** Optimistic-concurrency versions (R38): runtime bumps on status/spawn/
   *  relaunch/archive (under the gate); desired bumps on declarative writes. */
  runtimeVersion?: number | null
  desiredVersion?: number | null
  /** Agent preset this session launched from (S8), for the primer + chip. */
  agentRelPath?: string | null
  /** Per-session reasoning effort. null → the provider CLI's own default. An
   *  AGENT_IDE_EFFORT env var still outranks this at spawn (resolveEffort). */
  effort?: Effort | null
  /** Parsed provider usage summary (S5). */
  cost?: CostSummary | null
}

// ---------------------------------------------------------------------------
// v2 Backlog
// ---------------------------------------------------------------------------
/** Backlog item kind — an epic owns goals/tasks/tickets; a goal owns tasks/
 *  tickets; tasks and tickets are leaves. */
export type BacklogKind = 'epic' | 'goal' | 'task' | 'ticket'
/** User/CRUD-set lifecycle status (R33/R34) — written ONLY by manual moves. */
export type BacklogManualStatus = 'icebox' | 'planned' | 'done'
/** Session-derived state (R33/R34) — written ONLY by recomputeItemStatus. */
export type BacklogSessionState = 'none' | 'in-session' | 'done-by-ticket'
/** Provenance. Only 'manual' is renderer-creatable; the rest are main-owned. */
export type BacklogSource = 'manual' | 'agent' | 'linear' | 'generated'
/** The displayed/effective status: done-by-ticket > in-session > manualStatus.
 *  'in-session' surfaces when any bound session is active. */
export type BacklogEffectiveStatus = 'icebox' | 'planned' | 'in-session' | 'done'

export interface BacklogItem {
  id: string
  projectId: string
  kind: BacklogKind
  title: string
  bodyMd: string
  /** User-set lifecycle status (R34). */
  manualStatus: BacklogManualStatus
  /** Derived from bound sessions (R34). */
  sessionState: BacklogSessionState
  /** Linear's state-mapped value; present only on linear-sourced rows (R5). */
  remoteStatus?: string | null
  source: BacklogSource
  parentId?: string | null
  linearId?: string | null
  linearUrl?: string | null
  /** Content hash for inbox/linear dedupe idempotency. */
  contentHash?: string | null
  createdAt: number
  updatedAt: number
}

/** Renderer-supplied fields for creating a manual backlog item. Provenance and
 *  identity are assigned by MAIN (R17) — never accepted from the renderer. */
export interface BacklogCreateInput {
  projectId: string
  kind: BacklogKind
  title: string
  bodyMd?: string
  manualStatus?: BacklogManualStatus
  parentId?: string | null
}

/** Renderer-supplied fields for editing a manual/agent backlog item. Only these
 *  are writable through the generic CRUD path; identity/provenance are immutable. */
export interface BacklogUpdateInput {
  id: string
  title?: string
  bodyMd?: string
  manualStatus?: BacklogManualStatus
  parentId?: string | null
}

// ---------------------------------------------------------------------------
// v2 Queue
// ---------------------------------------------------------------------------
export type QueueState = 'pending' | 'launching' | 'launched' | 'failed'

export interface QueueItem {
  id: string
  projectId: string
  objective: string
  provider: Provider
  model: string
  useContainer: boolean
  taskKind?: TaskKind | null
  taskSubkind?: TaskSubkind | null
  agentRelPath?: string | null
  /** Bound backlog item ids (JSON array in the DB). */
  backlogItemIds: string[]
  position: number
  state: QueueState
  attempts: number
  launchedSessionId?: string | null
  lastError?: string | null
  /** Per-attempt lease token (R9-2) fencing stale async launches. */
  leaseToken?: string | null
  /** The app-boot that owns an in-flight claim (R8). */
  ownerBootId?: string | null
  claimedAt?: number | null
  createdAt: number
}

// ---------------------------------------------------------------------------
// v2 Snapshots (schema + seam frozen; capture is a deferred no-op this run)
// ---------------------------------------------------------------------------
export type SnapshotKind = 'baseline' | 'recovery'

export interface Snapshot {
  id: string
  projectId: string
  sessionId?: string | null
  kind: SnapshotKind
  /** write-tree of the real index (R22). */
  indexTreeSha: string
  /** temp-index add -A capture of the full worktree (R22). */
  workTreeSha: string
  /** the published worktree commit whose parent is the index-tree commit (R24). */
  commitSha: string
  createdAt: number
}

export interface RollbackPreviewFile {
  path: string
  change: 'modified' | 'added' | 'deleted'
}

export interface RollbackPreview {
  /** Opaque token binding apply to the previewed repo state (R18/R20). */
  previewToken: string
  files: RollbackPreviewFile[]
}

// ---------------------------------------------------------------------------
// v2 Git awareness (read-only this run — S4 reduced per SNAPSHOT scope decision)
// ---------------------------------------------------------------------------
export interface GitStatusSummary {
  branch: string
  ahead: number
  behind: number
  dirtyCount: number
}

export interface GitDiff {
  stat: string
  patch: string
  truncated: boolean
}

// ---------------------------------------------------------------------------
// v2 Cost + attention (S5)
// ---------------------------------------------------------------------------
export interface CostSummary {
  inputTokens?: number
  outputTokens?: number
  costUSD?: number
  provider: Provider
  updatedAt: number
  /** Raw matched summary text, capped ≤2KB. */
  raw: string
}

/** Ephemeral attention flag (never persisted, R20). */
export type AttentionState = 'input' | 'idle' | null

// ---------------------------------------------------------------------------
// v2 Search (S7) — discriminated union (R10/R34)
// ---------------------------------------------------------------------------
export type SearchHit =
  | { type: 'transcript'; sessionId: string; projectId: string; snippet: string; ts: number }
  | {
      type: 'backlog'
      itemId: string
      projectId: string
      title: string
      snippet: string
      status: BacklogEffectiveStatus
      kind: BacklogKind
    }

// ---------------------------------------------------------------------------
// v2 Linear (S2)
// ---------------------------------------------------------------------------
export interface LinearLink {
  accountId: string
  workspaceId: string
  teamId?: string | null
  projectId?: string | null
  label: string
}

export interface LinearIssueRef {
  id: string
  identifier: string
  title: string
  url: string
  state: string
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

/** A library item — a Prompt, Skill, Workflow, or Agent read from the library
 *  folder. `relPath` is the item's path relative to the library root (used for
 *  confined reads); `path` is the absolute path for display/debug. */
export type LibraryCategory = 'prompts' | 'skills' | 'workflows' | 'agents'

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
  agents: LibraryItem[]
}

/** Input for creating an agent in the library: frontmatter meta plus the three
 *  layered body sections (any may be empty). One agent = one markdown file. */
export interface AgentInput {
  name: string
  description: string
  instructions: string
  data: string
  context: string
}

/** External-service CLIs whose connectivity the status bar tracks. */
export const SERVICES = ['vercel', 'supabase', 'github', 'resend'] as const
export type ServiceName = (typeof SERVICES)[number]

/** A service's connectivity: online (installed + authenticated), needs login
 *  (installed but not authed), not installed, or unknown/errored. */
export type ServiceStatus = 'online' | 'not-logged-in' | 'not-installed' | 'unknown'
