import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Provider } from '@shared/types'
import { containerExecArgv } from './devcontainer'

const pexec = promisify(execFile)

export type Health = 'healthy' | 'not-logged-in' | 'not-installed' | 'unknown'

/** Where to run a provider command. */
export interface RunContext {
  /** containerId when the project runs in a devcontainer; undefined = host. */
  containerId?: string
}

interface ArgvCmd { cmd: string; args: string[] }

/** Is the CLI on PATH? (run via a login shell so PATH matches real usage). */
export function presenceArgv(provider: Provider): ArgvCmd {
  return { cmd: 'bash', args: ['-lc', `command -v ${provider}`] }
}

/** Non-interactive auth-status command, or null if the provider lacks one. */
export function authStatusArgv(provider: Provider): ArgvCmd | null {
  switch (provider) {
    case 'codex': return { cmd: 'codex', args: ['login', 'status'] }
    case 'claude': return { cmd: 'claude', args: ['auth', 'status'] }
    case 'gemini': return null // gemini has no non-interactive status command
  }
}

/** Interactive login command per provider. */
export function loginArgv(provider: Provider): ArgvCmd {
  switch (provider) {
    case 'codex': return { cmd: 'codex', args: ['login'] }
    case 'claude': return { cmd: 'claude', args: ['auth', 'login'] }
    case 'gemini': return { cmd: 'gemini', args: [] } // auths on first interactive launch
  }
}

const NPM_PKG: Record<Provider, string> = {
  codex: '@openai/codex',
  claude: '@anthropic-ai/claude-code',
  gemini: '@google/gemini-cli'
}

/** Global npm install of the provider package (used to install a CLI in a container). */
export function installArgv(provider: Provider): string[] {
  return ['npm', 'install', '-g', NPM_PKG[provider]]
}

/** Pure classifier from the two probe results. */
export function classifyHealth(p: { present: boolean; authOk: boolean | null }): Health {
  if (!p.present) return 'not-installed'
  if (p.authOk === true) return 'healthy'
  if (p.authOk === false) return 'not-logged-in'
  return 'unknown'
}

/** Wrap an argv to run in the given context (host or `docker exec` into container). */
function inContext(ctx: RunContext, cmd: string, args: string[]): ArgvCmd {
  if (ctx.containerId) return { cmd: 'docker', args: containerExecArgv(ctx.containerId, cmd, args) }
  return { cmd, args }
}

/** Probe a provider's health in a context. */
export async function probeHealth(provider: Provider, ctx: RunContext): Promise<Health> {
  // presence
  let present = false
  try {
    const base = presenceArgv(provider)
    const pa = inContext(ctx, base.cmd, base.args)
    await pexec(pa.cmd, pa.args)
    present = true
  } catch { present = false }
  if (!present) return 'not-installed'

  // auth
  const status = authStatusArgv(provider)
  if (!status) return classifyHealth({ present, authOk: null })
  let authOk: boolean | null = null
  try {
    const sa = inContext(ctx, status.cmd, status.args)
    await pexec(sa.cmd, sa.args)
    authOk = true
  } catch { authOk = false }
  return classifyHealth({ present, authOk })
}

/** Install a provider CLI in a container (mutates the container). */
export async function installInContainer(provider: Provider, containerId: string): Promise<void> {
  const [cmd, ...args] = installArgv(provider)
  await pexec('docker', containerExecArgv(containerId, cmd, args), { maxBuffer: 1024 * 1024 * 16 })
}
