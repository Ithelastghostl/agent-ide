import { isEffort, type Provider, type Effort } from '@shared/types'

export interface LaunchSpec {
  provider: Provider
  model: string
  autoApprove: boolean
  /** Reasoning effort. When set it is passed explicitly so it OUTRANKS the
   *  provider CLI's own config file; when undefined we pass nothing and the CLI
   *  keeps its configured default. */
  effort?: Effort
}

/**
 * How each provider CLI takes a reasoning-effort level. Verified against the
 * installed CLIs — they do NOT agree on a spelling:
 *   claude  --effort <level>            (native flag, same level names as ours)
 *   codex   -c model_reasoning_effort=… (no flag exists; -c overrides the value
 *                                        config.toml would otherwise supply)
 *   gemini  (nothing — the CLI has no reasoning-effort concept)
 * Returning [] means "no opinion", which leaves the CLI's own default intact.
 */
function effortArgs(provider: Provider, effort: Effort | undefined): string[] {
  if (!effort) return []
  switch (provider) {
    case 'claude':
      return ['--effort', effort]
    case 'codex':
      // Codex's own enum is none|minimal|low|medium|high|xhigh|max|ultra, so it
      // accepts every level we offer — no clamping needed. Quoted so the value
      // parses as a TOML string rather than a bare token.
      return ['-c', `model_reasoning_effort="${effort}"`]
    case 'gemini':
      return []
  }
}

/**
 * NN0 GUARD: flags that route a provider CLI into a headless / API-key billed
 * path. These must NEVER appear in a launch — sessions run strictly through the
 * user's subscription via the interactive CLI. The unit test asserts none of
 * these ever leak into argv, for any provider, with auto-approve on or off.
 */
export const FORBIDDEN_FLAGS = [
  '-p',
  '--print',
  '--bare',
  '--prompt',
  'exec', // codex non-interactive subcommand
  '--output-format' // gemini headless streaming
] as const

/**
 * Resolve the effort a launch should actually use, highest priority first:
 *
 *   1. AGENT_IDE_EFFORT   — the env var set on the command line. Deliberately
 *                           OUTRANKS everything, including a per-session pick,
 *                           so `AGENT_IDE_EFFORT=max agent-ide` wins outright.
 *   2. sessionEffort      — the per-session choice made in the picker.
 *   3. undefined          — pass no flag; the provider CLI keeps its own default
 *                           (e.g. ~/.codex/config.toml model_reasoning_effort).
 *
 * An unrecognised env value is ignored rather than fatal — a typo must not
 * silently downgrade a session, and it must not block the app from starting.
 */
export function resolveEffort(sessionEffort?: Effort | null, env: NodeJS.ProcessEnv = process.env): Effort | undefined {
  const raw = env.AGENT_IDE_EFFORT?.trim().toLowerCase()
  if (raw && isEffort(raw)) return raw
  return sessionEffort ?? undefined
}

/**
 * Build the command + argv to launch a provider as an INTERACTIVE,
 * subscription-logged-in session with the chosen model. Auto-approve flags are
 * only ever passed when the caller decides it's safe (inside a devcontainer,
 * per D26) — they still run under the interactive subscription login.
 */
export function launchArgv(s: LaunchSpec): { cmd: string; args: string[] } {
  const effort = effortArgs(s.provider, s.effort)
  switch (s.provider) {
    case 'claude': {
      const args = ['--model', s.model, ...effort]
      if (s.autoApprove) args.push('--dangerously-skip-permissions')
      return { cmd: 'claude', args }
    }
    case 'codex': {
      const args = ['-m', s.model, ...effort]
      if (s.autoApprove) args.push('--dangerously-bypass-approvals-and-sandbox')
      return { cmd: 'codex', args }
    }
    case 'gemini': {
      const args = ['-m', s.model, ...effort]
      if (s.autoApprove) args.push('--yolo')
      return { cmd: 'gemini', args }
    }
  }
}

// NOTE: there is intentionally no resumeArgv. Reconnecting a session does NOT use
// the provider CLI's own resume (--continue / resume --last / --resume latest):
// those attach to whichever conversation the CLI saw last, which made independent
// sessions of the same provider bleed into one history. The IDE owns each
// session's history and reconnects by launching the engine fresh (launchArgv) and
// replaying a cleaned-history primer — see src/main/history.ts and session:resume.
