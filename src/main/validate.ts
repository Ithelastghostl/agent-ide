import { isProvider, type Provider, type Session, type SessionStatus, type TaskKind, type TaskSubkind } from '@shared/types'
import { modelsFor } from './models'
import type { LaunchRequest } from './ipc' // type-only: no runtime cycle

/** B9: runtime validation of IPC payloads. TypeScript types do not cross the
 *  renderer→main boundary, so every field arriving from the renderer is validated
 *  here in main before use — enum membership, string type + length caps, model
 *  membership, project ownership, and status-enum ("transition") checks. Each
 *  guard throws a descriptive Error naming the offending field. */

const MAX_LEN = 4096 // generous cap for ids/paths/objectives; rejects abuse, not real input
const STATUSES: readonly SessionStatus[] = ['running', 'idle', 'archived']

export function asString(v: unknown, field: string, opts: { max?: number; allowEmpty?: boolean } = {}): string {
  if (typeof v !== 'string') throw new Error(`invalid ${field}: expected string`)
  if (!opts.allowEmpty && v.length === 0) throw new Error(`invalid ${field}: must not be empty`)
  if (v.length > (opts.max ?? MAX_LEN)) throw new Error(`invalid ${field}: too long`)
  return v
}

export function asBool(v: unknown, field: string): boolean {
  if (typeof v !== 'boolean') throw new Error(`invalid ${field}: expected boolean`)
  return v
}

function asProvider(v: unknown, field = 'provider'): Provider {
  if (typeof v !== 'string' || !isProvider(v)) throw new Error(`invalid ${field}: unknown provider`)
  return v
}

/** True iff `model` is a known model id for `provider` (model membership). */
export function isKnownModel(provider: Provider, model: string): boolean {
  return modelsFor(provider).some((m) => m.id === model)
}

function asKnownModel(provider: Provider, v: unknown, field = 'model'): string {
  const model = asString(v, field)
  if (!isKnownModel(provider, model)) throw new Error(`invalid ${field}: not a known model for ${provider}`)
  return model
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

const TASK_KINDS: readonly TaskKind[] = ['product', 'analysis']
const TASK_SUBKINDS: readonly TaskSubkind[] = ['code', 'feature', 'bug']

// M-LOG task lifecycle order (§4.1). A status may advance to itself or the next
// state(s); it never moves backward. 'ticketed' is terminal.
const TASK_ORDER = ['open', 'finished', 'deployed', 'ticketed'] as const
type TaskStatusName = typeof TASK_ORDER[number]

/** Validate a task-status transition (§4.1): forward-only along
 *  open→finished→deployed→ticketed (self-transition allowed for idempotency).
 *  Returns the validated target status; throws on an unknown or backward move. */
export function validateTaskTransition(from: unknown, to: unknown): TaskStatusName {
  const iTo = TASK_ORDER.indexOf(to as TaskStatusName)
  if (iTo < 0) throw new Error(`invalid task status: ${String(to)}`)
  // `from` may be null/undefined for a freshly-seen session — treat as 'open'.
  const fromName = (typeof from === 'string' && TASK_ORDER.includes(from as TaskStatusName) ? from : 'open') as TaskStatusName
  const iFrom = TASK_ORDER.indexOf(fromName)
  if (iTo < iFrom) throw new Error(`invalid task transition: ${fromName} → ${String(to)} (backward)`)
  return to as TaskStatusName
}

/** Validate the M-LOG task label (§4.1). Agent sessions must carry a kind; a
 *  'product' kind must carry a subkind; 'analysis' must not. Returns the
 *  validated pair (both undefined only if the caller allows an unlabeled
 *  session — terminals, which don't go through this validator). */
export function validateTaskLabel(kind: unknown, subkind: unknown): { taskKind: TaskKind; taskSubkind?: TaskSubkind } {
  if (typeof kind !== 'string' || !TASK_KINDS.includes(kind as TaskKind)) {
    throw new Error('invalid taskKind: expected "product" or "analysis"')
  }
  const taskKind = kind as TaskKind
  if (taskKind === 'product') {
    if (typeof subkind !== 'string' || !TASK_SUBKINDS.includes(subkind as TaskSubkind)) {
      throw new Error('invalid taskSubkind: a product task requires "code", "feature", or "bug"')
    }
    return { taskKind, taskSubkind: subkind as TaskSubkind }
  }
  if (subkind !== undefined && subkind !== null) {
    throw new Error('invalid taskSubkind: only product tasks have a subkind')
  }
  return { taskKind }
}

function asStringArray(v: unknown, field: string, max = 200): string[] {
  if (!Array.isArray(v)) throw new Error(`invalid ${field}: expected array`)
  if (v.length > max) throw new Error(`invalid ${field}: too many items`)
  return v.map((x, i) => asString(x, `${field}[${i}]`, { allowEmpty: true }))
}

/** M-LOG-b (§4.4): validate the schema-constrained ticket the addendum CLI must
 *  emit — a single JSON object {title, subkind, problem, solution,
 *  files_touched[], key_decisions[], follow_ups[], test_status, deploy_ref}.
 *  Throws on any shape mismatch (the caller retries once with the error, then
 *  surfaces a ticket-failed state). Reuses the B9 field guards. */
export function validateTicketFields(v: unknown): import('@shared/types').TicketFields {
  if (!isRecord(v)) throw new Error('invalid ticket: expected a JSON object')
  const subkind = v.subkind
  if (typeof subkind !== 'string' || !TASK_SUBKINDS.includes(subkind as TaskSubkind)) {
    throw new Error('invalid ticket.subkind: expected code|feature|bug')
  }
  return {
    title: asString(v.title, 'ticket.title', { max: 200 }),
    subkind: subkind as TaskSubkind,
    problem: asString(v.problem, 'ticket.problem', { allowEmpty: true, max: 20000 }),
    solution: asString(v.solution, 'ticket.solution', { allowEmpty: true, max: 20000 }),
    files_touched: asStringArray(v.files_touched, 'ticket.files_touched'),
    key_decisions: asStringArray(v.key_decisions, 'ticket.key_decisions'),
    follow_ups: asStringArray(v.follow_ups, 'ticket.follow_ups'),
    test_status: asString(v.test_status, 'ticket.test_status', { allowEmpty: true, max: 2000 }),
    deploy_ref: asString(v.deploy_ref, 'ticket.deploy_ref', { allowEmpty: true, max: 2000 })
  }
}

/** Validate a session:launch payload. `isKnownProject` enforces project ownership
 *  — main resolves the confined root by projectId (B1), so an unknown project is
 *  refused here too. M-LOG-a: an agent launch must carry a valid task label. */
export function validateLaunchRequest(v: unknown, isKnownProject: (id: string) => boolean): LaunchRequest {
  if (!isRecord(v)) throw new Error('invalid launch request: expected object')
  const provider = asProvider(v.provider)
  const projectId = asString(v.projectId, 'projectId')
  if (!isKnownProject(projectId)) throw new Error(`invalid projectId: unknown project`)
  const { taskKind, taskSubkind } = validateTaskLabel(v.taskKind, v.taskSubkind)
  return {
    projectId,
    provider,
    model: asKnownModel(provider, v.model),
    objective: asString(v.objective, 'objective', { allowEmpty: true }),
    cwd: asString(v.cwd, 'cwd', { allowEmpty: true }),
    useContainer: asBool(v.useContainer, 'useContainer'),
    importConfig: v.importConfig === undefined ? undefined : asBool(v.importConfig, 'importConfig'),
    taskKind,
    taskSubkind
  }
}

/** Validate a session:resume payload (a persisted Session round-tripped through
 *  the renderer). Checks provider/model membership and that status is a known
 *  enum value (guards the status-transition logic that follows). */
export function validateResumeSession(v: unknown): Session {
  if (!isRecord(v)) throw new Error('invalid session: expected object')
  const provider = asProvider(v.provider)
  const status = asString(v.status, 'status') as SessionStatus
  if (!STATUSES.includes(status)) throw new Error(`invalid status: unknown session status`)
  return {
    id: asString(v.id, 'id'),
    projectId: asString(v.projectId, 'projectId'),
    provider,
    model: asKnownModel(provider, v.model),
    objective: asString(v.objective, 'objective', { allowEmpty: true }),
    status,
    createdAt: typeof v.createdAt === 'number' ? v.createdAt : 0,
    updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : 0
  }
}
