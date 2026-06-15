import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const pexec = promisify(execFile)

/** argv for `devcontainer up --workspace-folder <ws>`. */
export function devcontainerUpArgv(workspace: string): string[] {
  return ['up', '--workspace-folder', workspace]
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

/** argv for `docker exec -it [-w cwd] <id> <cmd> <args...>`. */
export function containerExecArgv(
  containerId: string,
  cmd: string,
  args: string[],
  cwd?: string
): string[] {
  const base = ['exec', '-it']
  if (cwd) base.push('-w', cwd)
  base.push(containerId, cmd, ...args)
  return base
}

/** Bring up the project's devcontainer (same tool VS Code uses) and return its id. */
export async function upDevcontainer(workspace: string): Promise<{ containerId: string }> {
  const { stdout } = await pexec('devcontainer', devcontainerUpArgv(workspace), {
    maxBuffer: 1024 * 1024 * 32
  })
  return { containerId: parseContainerId(stdout) }
}

/** True if the devcontainer CLI is on PATH. */
export async function hasDevcontainerCli(): Promise<boolean> {
  try {
    await pexec('devcontainer', ['--version'])
    return true
  } catch {
    return false
  }
}
