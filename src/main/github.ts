import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

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
  const { stdout } = await pexec('gh', ['repo', 'list', '--json', 'nameWithOwner,name', '--limit', String(limit)])
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

/** Derive a project folder name from a git URL or owner/name spec. */
export function repoNameFromUrl(url: string): string {
  const cleaned = url.replace(/\.git$/, '').replace(/\/+$/, '')
  const last = cleaned.split(/[/:]/).pop() ?? cleaned
  return last || 'project'
}

/** Run the history-sync commands in a given repo directory. */
export async function syncHistory(repoDir: string, timestamp: string): Promise<void> {
  for (const [cmd, args] of buildHistorySyncCommands(timestamp)) {
    try {
      await pexec(cmd, args, { cwd: repoDir })
    } catch {
      // `git commit` exits non-zero when there's nothing to commit — ignore so
      // a no-op sync doesn't throw.
    }
  }
}
