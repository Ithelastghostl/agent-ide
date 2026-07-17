import type { Store } from '../store'
import type { Runtime } from '../runtime'
import type { LaunchService } from '../launchService'

/** Shared dependencies handed to every feature IPC registrar (P0.A composition
 *  root). A registrar edits ONLY its own area + its own modules. */
export interface IpcDeps {
  store?: Store
  runtime: Runtime
  launch: LaunchService
  /** Resolve a project's confined filesystem root (main-owned, C-5). */
  projectRoot: (projectId: string) => string | undefined
  /** Send an event to the current live renderer. */
  send: (channel: string, payload: unknown) => void
}

/** Typed not-implemented result for stubbed stream handlers. */
export const NOT_IMPLEMENTED = { error: 'not-implemented' } as const
