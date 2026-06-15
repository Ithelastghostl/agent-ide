import type { Provider } from '@shared/types'

export interface LaunchSpec {
  provider: Provider
  model: string
  autoApprove: boolean
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
 * Build the command + argv to launch a provider as an INTERACTIVE,
 * subscription-logged-in session with the chosen model. Auto-approve flags are
 * only ever passed when the caller decides it's safe (inside a devcontainer,
 * per D26) — they still run under the interactive subscription login.
 */
export function launchArgv(s: LaunchSpec): { cmd: string; args: string[] } {
  switch (s.provider) {
    case 'claude': {
      const args = ['--model', s.model]
      if (s.autoApprove) args.push('--dangerously-skip-permissions')
      return { cmd: 'claude', args }
    }
    case 'codex': {
      const args = ['-m', s.model]
      if (s.autoApprove) args.push('--dangerously-bypass-approvals-and-sandbox')
      return { cmd: 'codex', args }
    }
    case 'gemini': {
      const args = ['-m', s.model]
      if (s.autoApprove) args.push('--yolo')
      return { cmd: 'gemini', args }
    }
  }
}

/** Resume an existing session's conversation (interactive). Used in L6. */
export function resumeArgv(provider: Provider): { cmd: string; args: string[] } {
  switch (provider) {
    case 'claude':
      return { cmd: 'claude', args: ['--continue'] }
    case 'codex':
      return { cmd: 'codex', args: ['resume', '--last'] }
    case 'gemini':
      return { cmd: 'gemini', args: ['--resume', 'latest'] }
  }
}
