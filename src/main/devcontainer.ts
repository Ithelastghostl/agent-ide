import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { join, basename } from 'node:path'

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

/** Standard devcontainer non-root home — the FALLBACK when the container's
 *  passwd can't be queried. The authoritative home comes from
 *  resolveContainerHome() (getent in the container). */
export const CONTAINER_HOME = '/home/node'

// ---- Credential seeding (R3-2) ---------------------------------------------
// Host provider credentials are COPIED one-way into the container user's
// writable home via `docker cp` on container start (the devcontainer CLI's
// --mount rejects `readonly`, and a copy beats a mount anyway: nothing can
// write back to the host, existing files are never overwritten, and containers
// built BEFORE this feature get credentials too — no rebuild needed).

export interface SeedFile {
  hostPath: string
  provider: 'codex' | 'gemini' | 'claude'
  file: string
}

/** The host credential/config files worth seeding, filtered to those that exist.
 *  Small allowlists — NOT whole dot-dirs (~/.codex holds session DBs and caches;
 *  ~/.claude can hold hundreds of MB of skills/sessions). `includeClaude` is the
 *  importConfig opt-in. On macOS claude's OAuth lives in the Keychain, so its
 *  .credentials.json usually doesn't exist — in-container /login covers it. */
export function providerSeedFiles(
  hostHome: string,
  opts: { includeClaude: boolean },
  exists: (p: string) => boolean = existsSync
): SeedFile[] {
  const spec: [SeedFile['provider'], string, string[]][] = [
    ['codex', '.codex', ['auth.json', 'config.toml']],
    ['gemini', '.gemini', ['oauth_creds.json', 'google_accounts.json', 'settings.json']]
  ]
  if (opts.includeClaude) spec.push(['claude', '.claude', ['.credentials.json', 'settings.json', 'CLAUDE.md']])
  const files: SeedFile[] = []
  for (const [provider, dir, names] of spec) {
    for (const file of names) {
      const hostPath = join(hostHome, dir, file)
      if (exists(hostPath)) files.push({ hostPath, provider, file })
    }
  }
  return files
}

/** In-container destination for one seed file. */
export function seedTarget(home: string, f: SeedFile): string {
  return `${home}/.${f.provider}/${f.file}`
}

/** Copy seed files into the container user's writable home. Idempotent:
 *  container-local state always wins (a file already present is left alone, so
 *  in-container logins and refreshed tokens are never clobbered). Ownership is
 *  fixed to the session user; docker exec runs as root for the fs plumbing. */
export async function seedCredentialsInContainer(
  containerId: string,
  user: string | null,
  home: string,
  files: SeedFile[]
): Promise<void> {
  for (const f of files) {
    const dst = seedTarget(home, f)
    const dir = dst.slice(0, dst.lastIndexOf('/'))
    const { stdout } = await pexec('docker', ['exec', containerId, 'sh', '-c', `test -e ${dst} && echo EXISTS || echo MISSING`])
    if (stdout.includes('EXISTS')) continue
    await pexec('docker', ['exec', '-u', 'root', containerId, 'sh', '-c', `mkdir -p ${dir}`])
    await pexec('docker', ['cp', f.hostPath, `${containerId}:${dst}`])
    if (user) {
      await pexec('docker', ['exec', '-u', 'root', containerId, 'sh', '-c', `chown -R ${user} ${dir} && chmod 600 ${dst}`])
    }
  }
}

// ---- Container exec context (R3-1) -----------------------------------------

/** argv for `devcontainer read-configuration` (merged config incl. extends). */
export function readConfigurationArgv(workspace: string): string[] {
  return ['read-configuration', '--workspace-folder', workspace]
}

/** Extract the container-side workspace folder from read-configuration output;
 *  falls back to the devcontainer CLI convention /workspaces/<basename>. */
export function parseWorkspaceFolder(stdout: string, workspace: string): string {
  for (const line of stdout.split('\n').reverse()) {
    const m = line.match(/"workspaceFolder"\s*:\s*"([^"]+)"/)
    if (m) return m[1]
  }
  return `/workspaces/${basename(workspace)}`
}

/** The container-side workspace folder for a workspace (via the CLI's merged
 *  configuration; falls back to the /workspaces/<name> convention). */
export async function containerWorkspaceFolder(workspace: string): Promise<string> {
  try {
    const { stdout } = await pexec(devcontainerBin(), readConfigurationArgv(workspace), { maxBuffer: 1024 * 1024 * 8 })
    return parseWorkspaceFolder(stdout, workspace)
  } catch {
    return parseWorkspaceFolder('', workspace)
  }
}

/** Authoritative home for a container user: the container's own passwd entry
 *  (covers nonstandard homes), falling back to the /root / /home/<user> rule. */
export async function resolveContainerHome(containerId: string, user: string | null): Promise<string> {
  const fallback = !user ? CONTAINER_HOME : user === 'root' ? '/root' : `/home/${user}`
  if (!user) return fallback
  try {
    const { stdout } = await pexec('docker', ['exec', containerId, 'sh', '-c',
      `getent passwd ${user} | cut -d: -f6`])
    const home = stdout.trim().split('\n')[0]?.trim()
    return home || fallback
  } catch {
    return fallback
  }
}

/** Bind-mount of the IDE's library folder (an absolute host path, e.g.
 *  ~/AgentIDE/library) into the container at <home>/.agent-ide/library, so a
 *  containerized session's CLI can read the library's skills/workflows/agents.
 *  NOT read-only: the devcontainer CLI's --mount grammar rejects `readonly`
 *  (only type/source/target/external) — an in-container agent can therefore
 *  write the library; it is the user's own content, documented in RUNNING.md. */
export function libraryConfigMount(libHostDir: string, containerHome: string = CONTAINER_HOME): string {
  return `type=bind,source=${libHostDir},target=${containerHome}/.agent-ide/library`
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

/** Extract the in-container workspace path (`remoteWorkspaceFolder`) from
 *  `devcontainer up` JSON output — the directory the workspace is bind-mounted to
 *  inside the container (e.g. /workspaces/<repo>). This is the cwd sessions must
 *  exec in; without it `docker exec` lands in the image's default WORKDIR (often
 *  `/`), which is why agents were starting at the root directory. Returns null if
 *  absent (older CLI / unexpected output) so the caller can fall back. */
export function parseRemoteWorkspaceFolder(stdout: string): string | null {
  const lines = stdout.split('\n').reverse()
  for (const line of lines) {
    const m = line.match(/"remoteWorkspaceFolder"\s*:\s*"([^"]+)"/)
    if (m) return m[1]
  }
  return null
}

/** The conventional in-container workspace path for a host workspace folder: the
 *  devcontainer CLI bind-mounts <host>/<name> to /workspaces/<name> by default.
 *  Used as a last-resort fallback when we can't read the real path from Docker. */
export function defaultWorkspaceFolder(hostWorkspace: string): string {
  const name = hostWorkspace.replace(/\/+$/, '').split('/').pop() || 'workspace'
  return `/workspaces/${name}`
}

/** argv for `docker exec [-it] [-u user] [-w cwd] [-e K=V] <id> <cmd> <args...>`.
 *  `interactive` (default true) adds `-it` for pty/terminal sessions; pass
 *  false for non-TTY `execFile` calls (health/install) which would otherwise
 *  hang trying to allocate a TTY (Codex P2).
 *  `user` runs the command as that container user (e.g. the devcontainer's
 *  remoteUser, 'node'). Needed because agent CLIs refuse to run as root with
 *  auto-approve (claude --dangerously-skip-permissions errors under euid 0).
 *  `env` sets container-side env vars — HOME in particular, since `-u` does NOT
 *  set it and provider CLIs resolve credentials relative to it (R3-1). */
export function containerExecArgv(
  containerId: string,
  cmd: string,
  args: string[],
  opts: { cwd?: string; interactive?: boolean; user?: string; env?: Record<string, string> } = {}
): string[] {
  const interactive = opts.interactive ?? true
  const base = ['exec']
  if (interactive) base.push('-it')
  if (opts.user) base.push('-u', opts.user)
  if (opts.cwd) base.push('-w', opts.cwd)
  for (const [k, v] of Object.entries(opts.env ?? {})) base.push('-e', `${k}=${v}`)
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

/** Bring up the project's devcontainer (same tool VS Code uses) and return its id
 *  plus the in-container workspace folder (the cwd sessions must exec in). When
 *  `up` doesn't report remoteWorkspaceFolder, fall back to the /workspaces/<name>
 *  convention so sessions still start in the project, not the image WORKDIR. */
export async function upDevcontainer(
  workspace: string,
  mounts: string[] = []
): Promise<{ containerId: string; workspaceFolder: string }> {
  const { stdout } = await pexec(devcontainerBin(), devcontainerUpArgv(workspace, mounts), {
    maxBuffer: 1024 * 1024 * 32
  })
  return {
    containerId: parseContainerId(stdout),
    workspaceFolder: parseRemoteWorkspaceFolder(stdout) ?? defaultWorkspaceFolder(workspace)
  }
}

/** Resolve the in-container workspace folder for an ALREADY-RUNNING (or restarted)
 *  container we didn't just `up` — read the destination of the bind mount whose
 *  source is the host workspace (where the project is actually mounted). Falls
 *  back to the /workspaces/<name> convention if the mount can't be read. This is
 *  the `-w` for sessions reusing an existing container. */
export async function resolveWorkspaceFolder(containerId: string, hostWorkspace: string): Promise<string> {
  try {
    const host = hostWorkspace.replace(/\/+$/, '')
    const { stdout } = await pexec('docker', [
      'inspect', '-f',
      '{{range .Mounts}}{{.Source}}\t{{.Destination}}{{"\\n"}}{{end}}',
      containerId
    ])
    for (const line of stdout.split('\n')) {
      const [src, dest] = line.split('\t')
      if (src && dest && src.replace(/\/+$/, '') === host) return dest
    }
  } catch {
    /* fall through to convention */
  }
  return defaultWorkspaceFolder(hostWorkspace)
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

/** Stop a running container by id (reversible — preserves its filesystem/state;
 *  `findContainerPresence` will then report it 'stopped', so the UI offers a
 *  restart rather than a rebuild). Any sessions execing into it lose their pty. */
export async function stopContainerById(id: string): Promise<void> {
  await pexec('docker', ['stop', id])
}
