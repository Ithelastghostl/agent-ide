import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { historyDir } from './history'

const pexec = promisify(execFile)

export interface Repo {
  repo: string // owner/name (nameWithOwner)
  name: string
}

/** Pure parser for `gh repo list --json nameWithOwner,name` output. */
export function parseRepoList(stdout: string): Repo[] {
  const arr = JSON.parse(stdout) as { nameWithOwner: string; name: string }[]
  return arr.map((r) => ({ repo: r.nameWithOwner, name: r.name }))
}

/** Pure builder for the history-sync command sequence (timestamp injected). */
export function buildHistorySyncCommands(timestamp: string): [string, string[]][] {
  return [
    ['git', ['add', '-A']],
    ['git', ['commit', '-m', `history: ${timestamp}`]],
    ['git', ['push']]
  ]
}

/** List the authenticated user's GitHub repos via the gh CLI. */
export async function listRepos(limit = 100): Promise<Repo[]> {
  const { stdout } = await pexec('gh', [
    'repo',
    'list',
    '--json',
    'nameWithOwner,name',
    '--limit',
    String(limit)
  ])
  return parseRepoList(stdout)
}

/** Clone a repo (owner/name) into dest via gh. */
export async function cloneRepo(repo: string, dest: string): Promise<void> {
  await pexec('gh', ['repo', 'clone', repo, dest])
}

/** Clone any git URL into dest via plain git. */
export async function cloneUrl(url: string, dest: string): Promise<void> {
  await pexec('git', ['clone', url, dest])
}

/** `git pull` an existing clone (used to refresh the library). */
export async function pullRepo(dir: string): Promise<void> {
  await pexec('git', ['-C', dir, 'pull', '--ff-only'])
}

/** Derive a project folder name from a git URL or owner/name spec. */
export function repoNameFromUrl(url: string): string {
  const cleaned = url.replace(/\.git$/, '').replace(/\/+$/, '')
  const last = cleaned.split(/[/:]/).pop() ?? cleaned
  return last || 'project'
}

/** Whether a git failure is the benign "nothing to commit" no-op (the ONLY error
 *  history-sync should swallow — B8). Everything else (no remote, auth failure,
 *  not a repo) is a real error the caller must see. */
export function isNothingToCommit(output: string): boolean {
  return /nothing to commit|nothing added to commit|no changes added to commit/i.test(output)
}

/** Status of one history-sync step. `skipped` marks a benign no-op (nothing to
 *  commit); `ok:false` with `error` is a real failure that was NOT swallowed. */
export interface SyncStepResult {
  step: 'add' | 'commit' | 'push'
  ok: boolean
  skipped?: boolean
  error?: string
}

/** Commit and push the IDE-owned history repo (B8). The directory is resolved
 *  internally (historyDir()) — never supplied by the renderer, which must not be
 *  able to run git in an arbitrary path. Returns per-step status; only "nothing
 *  to commit" is treated as a benign skip, all other failures are reported. */
export async function syncHistory(timestamp: string): Promise<SyncStepResult[]> {
  const dir = historyDir()
  const results: SyncStepResult[] = []
  for (const [cmd, args] of buildHistorySyncCommands(timestamp)) {
    const step = args[0] as SyncStepResult['step']
    try {
      await pexec(cmd, args, { cwd: dir })
      results.push({ step, ok: true })
    } catch (err) {
      const out = `${(err as { stdout?: string }).stdout ?? ''}\n${(err as { stderr?: string }).stderr ?? ''}\n${(err as Error).message ?? ''}`
      if (step === 'commit' && isNothingToCommit(out)) {
        results.push({ step, ok: true, skipped: true }) // benign no-op
      } else {
        results.push({ step, ok: false, error: ((err as Error).message || out).trim() })
      }
    }
  }
  return results
}
