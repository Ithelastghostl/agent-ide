import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HeadlessRunner } from './ticketService'

// M-LOG-b: the real headless runner for the addendum pass. NN0 resolved by the
// owner (2026-07-17): headless passes run through the subscription-logged-in
// claude CLI; FORBIDDEN_FLAGS still guards interactive session launches.
//
// Confinement (Codex R4/R5): the transcript in the prompt is untrusted, so the
// pass runs with ALL tools disabled, no user/project settings, no MCP, no
// session persistence, in a fresh empty cwd. Codex-as-fallback was dropped —
// its read-only sandbox cannot enforce a read allowlist.

/** Argv for one confined claude -p pass. Exported for deterministic tests. */
export function claudeHeadlessArgv(): { cmd: string; args: string[] } {
  return {
    cmd: 'claude',
    args: ['-p', '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence']
  }
}

export interface CliRunnerDeps {
  /** Spawn seam (child_process.spawn-compatible), injectable for tests. */
  spawn: typeof spawn
  /** Fresh empty working directory per pass. */
  mkWorkDir: () => string
  timeoutMs: number
  maxOutputBytes: number
}

const defaultDeps: CliRunnerDeps = {
  spawn,
  mkWorkDir: () => mkdtempSync(join(tmpdir(), 'agent-ide-ticket-')),
  timeoutMs: 5 * 60 * 1000,
  maxOutputBytes: 16 * 1024 * 1024
}

/** Env-var seam for tests/e2e: AGENT_IDE_TICKET_CMD is a JSON argv array (e.g.
 *  ["node","fixture.js"]) that replaces the claude invocation entirely. */
export function ticketCmdOverride(env: Record<string, string | undefined> = process.env): string[] | null {
  const raw = env.AGENT_IDE_TICKET_CMD
  if (!raw) return null
  try {
    const arr = JSON.parse(raw)
    if (Array.isArray(arr) && arr.length > 0 && arr.every((x) => typeof x === 'string')) return arr
  } catch { /* fall through */ }
  throw new Error('AGENT_IDE_TICKET_CMD must be a JSON array of strings')
}

/** Build the production runner: one confined `claude -p` pass per prompt, the
 *  prompt delivered on stdin (150k-char chunks would blow ARG_MAX as an arg). */
export function createCliHeadlessRunner(deps: Partial<CliRunnerDeps> = {}): HeadlessRunner {
  const d = { ...defaultDeps, ...deps }
  return (prompt: string) =>
    new Promise<string>((resolve, reject) => {
      const override = ticketCmdOverride()
      const { cmd, args } = override
        ? { cmd: override[0], args: override.slice(1) }
        : claudeHeadlessArgv()
      let cwd: string
      try {
        cwd = d.mkWorkDir()
      } catch (err) {
        reject(new Error(`ticket pass: cannot create work dir: ${(err as Error).message}`))
        return
      }
      const child = d.spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
      let out = ''
      let errOut = ''
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill('SIGKILL')
        reject(new Error(`ticket pass timed out after ${Math.round(d.timeoutMs / 1000)}s`))
      }, d.timeoutMs)
      const fail = (msg: string) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new Error(msg))
      }
      child.on('error', (err) =>
        fail(`ticket pass: failed to start ${cmd}: ${err.message} — is the claude CLI installed and on PATH?`))
      child.stdout?.on('data', (b: Buffer) => {
        out += b.toString('utf8')
        if (out.length > d.maxOutputBytes) {
          child.kill('SIGKILL')
          fail('ticket pass: output exceeded size cap')
        }
      })
      child.stderr?.on('data', (b: Buffer) => { errOut = (errOut + b.toString('utf8')).slice(-4000) })
      child.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (code === 0) resolve(out)
        else reject(new Error(`ticket pass: ${cmd} exited ${code}: ${errOut.trim() || 'no stderr'}`))
      })
      child.stdin?.on('error', () => { /* EPIPE when the CLI dies early — close() reports it */ })
      child.stdin?.end(prompt)
    })
}

/** Kept for the no-CLI edge and as the registerIpc default in tests. */
export const notEnabledRunner: HeadlessRunner = async () => {
  throw new Error(
    'ticket generation unavailable: no headless runner wired. In the app this means the claude CLI could not be used.'
  )
}
