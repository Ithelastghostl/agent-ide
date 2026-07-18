import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { SERVICES, type ServiceName, type ServiceStatus } from '@shared/types'

const pexec = promisify(execFile)

interface ArgvCmd {
  cmd: string
  args: string[]
}

/** The actual binary name on PATH for each service (the service id isn't always
 *  the command — GitHub's CLI is `gh`). */
const BIN: Record<ServiceName, string> = {
  vercel: 'vercel',
  supabase: 'supabase',
  github: 'gh',
  resend: 'resend'
}

/** Is the CLI on PATH? Run via a login shell so PATH matches real usage.
 *  Self-defensive (Codex P3): only the known binaries are ever interpolated. */
export function presenceArgv(service: ServiceName): ArgvCmd {
  const bin = BIN[service]
  if (!bin || !/^[a-z][a-z0-9-]*$/.test(bin)) {
    throw new Error(`refusing to probe unknown service: ${String(service)}`)
  }
  return { cmd: 'bash', args: ['-lc', `command -v ${bin}`] }
}

/** Non-interactive "am I authenticated?" command per service. All exit non-zero
 *  when not logged in. */
export function authStatusArgv(service: ServiceName): ArgvCmd {
  switch (service) {
    case 'vercel':
      return { cmd: 'vercel', args: ['whoami'] }
    case 'supabase':
      return { cmd: 'supabase', args: ['projects', 'list'] }
    case 'github':
      return { cmd: 'gh', args: ['auth', 'status'] }
    case 'resend':
      return { cmd: 'resend', args: ['whoami'] }
  }
}

/** Interactive login command per service — run in a terminal session (browser /
 *  device flow), not via execFile. */
export function loginArgv(service: ServiceName): ArgvCmd {
  switch (service) {
    case 'vercel':
      return { cmd: 'vercel', args: ['login'] }
    case 'supabase':
      return { cmd: 'supabase', args: ['login'] }
    case 'github':
      return { cmd: 'gh', args: ['auth', 'login'] }
    case 'resend':
      return { cmd: 'resend', args: ['login'] }
  }
}

/** Pure classifier from the two probe results. */
export function classifyServiceHealth(p: { present: boolean; authOk: boolean | null }): ServiceStatus {
  if (!p.present) return 'not-installed'
  if (p.authOk === true) return 'online'
  if (p.authOk === false) return 'not-logged-in'
  return 'unknown'
}

/** Run a command with a hard timeout — these CLIs (esp. `vercel whoami`) can hang
 *  on the network, and the status bar must never block on a stuck probe. */
async function runWithTimeout(cmd: string, args: string[], ms: number): Promise<void> {
  await pexec(cmd, args, { timeout: ms, killSignal: 'SIGKILL' })
}

/** Probe one service's connectivity (host-side). Presence first (fast), then a
 *  timeboxed auth check. Never throws — returns a ServiceStatus. */
export async function probeService(service: ServiceName, timeoutMs = 6000): Promise<ServiceStatus> {
  let present = false
  try {
    const pa = presenceArgv(service)
    await runWithTimeout(pa.cmd, pa.args, timeoutMs)
    present = true
  } catch {
    present = false
  }
  if (!present) return 'not-installed'

  let authOk: boolean | null = null
  try {
    const sa = authStatusArgv(service)
    await runWithTimeout(sa.cmd, sa.args, timeoutMs)
    authOk = true
  } catch {
    authOk = false
  }
  return classifyServiceHealth({ present, authOk })
}

/** Probe every tracked service in parallel. Returns a status map. */
export async function probeAllServices(timeoutMs = 6000): Promise<Record<ServiceName, ServiceStatus>> {
  const entries = await Promise.all(SERVICES.map(async (s) => [s, await probeService(s, timeoutMs)] as const))
  return Object.fromEntries(entries) as Record<ServiceName, ServiceStatus>
}
