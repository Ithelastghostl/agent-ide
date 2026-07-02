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

/** Standard devcontainer non-root home. Sessions exec as the remoteUser (commonly
 *  `node`, home /home/node), so provider creds must be mounted INTO THAT home —
 *  not /root — or the CLI (running as the remoteUser) won't find them. */
export const CONTAINER_HOME = '/home/node'

/** Build a read-only bind-mount of a host cred dir (e.g. ~/.claude, ~/.codex,
 *  ~/.gemini) into the container user's home, so a containerized session inherits
 *  the host's existing login instead of re-running an OAuth loopback that's
 *  trapped in the container's network namespace. `containerHome` defaults to the
 *  conventional remoteUser home. */
export function configMount(hostHome: string, dir: string, containerHome: string = CONTAINER_HOME): string {
  return `type=bind,source=${hostHome}/${dir},target=${containerHome}/${dir},readonly`
}

export const claudeConfigMount = (hostHome: string, containerHome?: string) => configMount(hostHome, '.claude', containerHome)
export const codexConfigMount = (hostHome: string, containerHome?: string) => configMount(hostHome, '.codex', containerHome)
export const geminiConfigMount = (hostHome: string, containerHome?: string) => configMount(hostHome, '.gemini', containerHome)

/** Read-only bind-mount of the IDE's library folder (an absolute host path, e.g.
 *  ~/AgentIDE/library) into the container at <home>/.agent-ide/library, so a
 *  containerized session's CLI can read the library's skills/workflows. */
export function libraryConfigMount(libHostDir: string, containerHome: string = CONTAINER_HOME): string {
  return `type=bind,source=${libHostDir},target=${containerHome}/.agent-ide/library,readonly`
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

/** argv for `docker exec [-it] [-u user] [-w cwd] <id> <cmd> <args...>`.
 *  `interactive` (default true) adds `-it` for pty/terminal sessions; pass
 *  false for non-TTY `execFile` calls (health/install) which would otherwise
 *  hang trying to allocate a TTY (Codex P2).
 *  `user` runs the command as that container user (e.g. the devcontainer's
 *  remoteUser, 'node'). Needed because agent CLIs refuse to run as root with
 *  auto-approve (claude --dangerously-skip-permissions errors under euid 0). */
export function containerExecArgv(
  containerId: string,
  cmd: string,
  args: string[],
  opts: { cwd?: string; interactive?: boolean; user?: string } = {}
): string[] {
  const interactive = opts.interactive ?? true
  const base = ['exec']
  if (interactive) base.push('-it')
  if (opts.user) base.push('-u', opts.user)
  if (opts.cwd) base.push('-w', opts.cwd)
  base.push(containerId, cmd, ...args)
  return base
}

/** Parse the devcontainer `remoteUser` out of a container's devcontainer.metadata
 *  label (the same value VS Code execs as). The label is a JSON array of feature/
 *  config fragments; the LAST `remoteUser` wins. Returns null if absent/unparseable. */
export function parseRemoteUser(metadataLabel: string | undefined): string | null {
  if (!metadataLabel) return null
  try {
    const meta = JSON.parse(metadataLabel) as Array<{ remoteUser?: string }>
    let user: string | null = null
    for (const frag of meta) if (frag && typeof frag.remoteUser === 'string') user = frag.remoteUser
    return user
  } catch {
    return null
  }
}

/** Resolve the non-root user to exec as inside a container: the devcontainer's
 *  declared remoteUser if any, else a real login user with uid >= 1000 (e.g.
 *  'node'/'vscode'), else null (stay default/root). Queried from Docker so it
 *  works without the project's .devcontainer on disk. */
export async function resolveContainerUser(containerId: string): Promise<string | null> {
  try {
    const { stdout: label } = await pexec('docker', [
      'inspect', '-f', '{{index .Config.Labels "devcontainer.metadata"}}', containerId
    ])
    const declared = parseRemoteUser(label.trim())
    if (declared && declared !== 'root') return declared
  } catch {
    /* fall through to passwd scan */
  }
  try {
    // First passwd entry with a uid in [1000, 65534): the conventional human user.
    const { stdout } = await pexec('docker', ['exec', containerId, 'sh', '-c',
      'getent passwd | awk -F: \'$3>=1000 && $3<65534 {print $1; exit}\''])
    const user = stdout.trim()
    return user || null
  } catch {
    return null
  }
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
