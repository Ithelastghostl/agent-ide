import { isProvider, type Provider, type Session, type SessionStatus } from '@shared/types'
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

/** Validate a session:launch payload. `isKnownProject` enforces project ownership
 *  — main resolves the confined root by projectId (B1), so an unknown project is
 *  refused here too. */
export function validateLaunchRequest(v: unknown, isKnownProject: (id: string) => boolean): LaunchRequest {
  if (!isRecord(v)) throw new Error('invalid launch request: expected object')
  const provider = asProvider(v.provider)
  const projectId = asString(v.projectId, 'projectId')
  if (!isKnownProject(projectId)) throw new Error(`invalid projectId: unknown project`)
  return {
    projectId,
    provider,
    model: asKnownModel(provider, v.model),
    objective: asString(v.objective, 'objective', { allowEmpty: true }),
    cwd: asString(v.cwd, 'cwd', { allowEmpty: true }),
    useContainer: asBool(v.useContainer, 'useContainer'),
    importConfig: v.importConfig === undefined ? undefined : asBool(v.importConfig, 'importConfig')
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
