import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const pexec = promisify(execFile)

/** Resolve the devcontainer CLI: prefer the locally-installed binary (bundled
 *  with the app), fall back to a `devcontainer` on PATH. */
export function devcontainerBin(): string {
  const local = join(process.cwd(), 'node_modules', '.bin', 'devcontainer')
  return existsSync(local) ? local : 'devcontainer'
}

/** argv for `devcontainer up --workspace-folder <ws>`, with optional extra
 *  bind mounts (e.g. ~/.claude read-only so in-container agents have your
 *  skills + config — F12). Each mount is a docker --mount string. */
export function devcontainerUpArgv(workspace: string, mounts: string[] = []): string[] {
  const args = ['up', '--workspace-folder', workspace]
  for (const m of mounts) args.push('--mount', m)
  return args
}

/** Build a read-only bind-mount string for ~/.claude into the container. */
export function claudeConfigMount(homeDir: string): string {
  return `type=bind,source=${homeDir}/.claude,target=/root/.claude,readonly`
}

/** Build a read-only bind-mount string for ~/.codex into the container, so a
 *  containerized Codex session inherits the host's existing login (OAuth token
 *  in ~/.codex/auth.json) instead of re-running login through the trapped
 *  in-container loopback (localhost:1455). */
export function codexConfigMount(homeDir: string): string {
  return `type=bind,source=${homeDir}/.codex,target=/root/.codex,readonly`
}

/** Extract the containerId from `devcontainer up` JSON output (last JSON line). */
export function parseContainerId(stdout: string): string {
  const lines = stdout.split('\n').reverse()
  for (const line of lines) {
    const m = line.match(/"containerId"\s*:\s*"([^"]+)"/)
    if (m) return m[1]
  }
  throw new Error('devcontainer up: no containerId in output')
}

/** argv for `docker exec [-it] [-w cwd] <id> <cmd> <args...>`.
 *  `interactive` (default true) adds `-it` for pty/terminal sessions; pass
 *  false for non-TTY `execFile` calls (health/install) which would otherwise
 *  hang trying to allocate a TTY (Codex P2). */
export function containerExecArgv(
  containerId: string,
  cmd: string,
  args: string[],
  opts: { cwd?: string; interactive?: boolean } = {}
): string[] {
  const interactive = opts.interactive ?? true
  const base = ['exec']
  if (interactive) base.push('-it')
  if (opts.cwd) base.push('-w', opts.cwd)
  base.push(containerId, cmd, ...args)
  return base
}

/** Bring up the project's devcontainer (same tool VS Code uses) and return its id. */
export async function upDevcontainer(workspace: string, mounts: string[] = []): Promise<{ containerId: string }> {
  const { stdout } = await pexec(devcontainerBin(), devcontainerUpArgv(workspace, mounts), {
    maxBuffer: 1024 * 1024 * 32
  })
  return { containerId: parseContainerId(stdout) }
}

/** True if the devcontainer CLI is available (local or on PATH). */
export async function hasDevcontainerCli(): Promise<boolean> {
  try {
    await pexec(devcontainerBin(), ['--version'])
    return true
  } catch {
    return false
  }
}

/** argv to find a RUNNING devcontainer for a workspace, by the label the
 *  devcontainer CLI sets. Survives app restarts (queries Docker, not memory). */
export function findContainerArgv(workspace: string): string[] {
  return ['ps', '--filter', `label=devcontainer.local_folder=${workspace}`, '--format', '{{.ID}}', '--no-trunc']
}

/** argv to find ANY devcontainer (running OR stopped) for a workspace, with its
 *  state, so we can distinguish "stopped, restart it" from "never built". */
export function findAnyContainerArgv(workspace: string): string[] {
  return ['ps', '-a', '--filter', `label=devcontainer.local_folder=${workspace}`, '--format', '{{.ID}} {{.State}}', '--no-trunc']
}

/** Return the running container id for a project workspace, or null. */
export async function findRunningContainer(workspace: string): Promise<string | null> {
  try {
    const { stdout } = await pexec('docker', findContainerArgv(workspace))
    const id = stdout.trim().split('\n')[0]?.trim()
    return id || null
  } catch {
    return null
  }
}

export type ContainerPresence =
  | { state: 'running'; id: string }
  | { state: 'stopped'; id: string }
  | { state: 'none' }

/** Parse `docker ps -a ... {{.ID}} {{.State}}` output, preferring a running one. */
export function parseContainerPresence(stdout: string): ContainerPresence {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean)
  let stopped: string | null = null
  for (const line of lines) {
    const [id, state] = line.split(/\s+/)
    if (!id) continue
    if (state === 'running') return { state: 'running', id }
    if (!stopped) stopped = id // exited / created / paused → treat as stopped
  }
  return stopped ? { state: 'stopped', id: stopped } : { state: 'none' }
}

/** Find a devcontainer for a workspace (running, stopped, or none). */
export async function findContainerPresence(workspace: string): Promise<ContainerPresence> {
  try {
    const { stdout } = await pexec('docker', findAnyContainerArgv(workspace))
    return parseContainerPresence(stdout)
  } catch {
    return { state: 'none' }
  }
}

/** Start an already-built but stopped container by id. */
export async function startContainerById(id: string): Promise<void> {
  await pexec('docker', ['start', id])
}
