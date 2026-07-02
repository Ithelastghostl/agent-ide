import type { HeadlessRunner } from './ticketService'

// M-LOG-b: the real headless CLI runner for the addendum pass (§4.4/D9) is
// DEFERRED. The plan specifies `claude -p` (JSON) / `codex exec`, but the NN0
// guard (src/main/providers.ts FORBIDDEN_FLAGS) currently bans -p/exec to keep
// everything on subscription billing — an unresolved hard-rule question flagged
// to the owner. Until that's decided, the default runner is a stub that fails
// cleanly, so a "Mark deployed → generate ticket" attempt surfaces a
// retry state (the session stays 'deployed') rather than silently billing an
// API key or crashing. Tests inject a fake runner to exercise the happy path.
//
// To enable for real (after the policy call): implement this to spawn the
// provider CLI on the host via runtime.host with a guarded argv, capture stdout,
// and return it — routing through whatever FORBIDDEN_FLAGS carve-out is agreed.

export const notEnabledRunner: HeadlessRunner = async () => {
  throw new Error(
    'ticket generation is not enabled yet: the headless addendum runner (claude -p / codex exec) ' +
    'awaits a subscription-billing (NN0) policy decision. See headlessRunner.ts.'
  )
}
