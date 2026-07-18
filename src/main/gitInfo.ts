import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GitStatusSummary, GitDiff } from '@shared/types'

const pexec = promisify(execFile)

/** Max bytes of raw `git diff` we surface in the read-only diff pane. Anything
 *  larger is truncated (flag set) so a huge working tree can't flood the UI or
 *  the IPC channel. */
export const DIFF_CAP_BYTES = 512 * 1024

// ---------------------------------------------------------------------------
// Pure parsers (unit-tested on fixture strings — no git invocation)
// ---------------------------------------------------------------------------

/** Parse `git status --porcelain=v2 --branch` stdout into a GitStatusSummary.
 *
 *  Porcelain v2 header lines start with `# branch.*`:
 *    # branch.oid <sha|(initial)>
 *    # branch.head <branch|(detached)>
 *    # branch.upstream <upstream>          (only when a remote is tracked)
 *    # branch.ab +<ahead> -<behind>        (only when an upstream exists)
 *  Non-header lines describe changed/untracked/unmerged entries:
 *    1 <XY> ...   ordinary change      2 <XY> ...   renamed/copied
 *    u <XY> ...   unmerged             ? <path>     untracked
 *  dirtyCount = every such entry (staged, unstaged, untracked, unmerged) — the
 *  count of paths differing from a clean HEAD. Detached HEAD → branch is the
 *  literal "(detached)" head value. */
export function parseStatusPorcelainV2(stdout: string): GitStatusSummary {
  let branch = ''
  let ahead = 0
  let behind = 0
  let dirtyCount = 0

  for (const line of stdout.split('\n')) {
    if (line === '') continue
    if (line.startsWith('# ')) {
      // Header line: "# branch.head main", "# branch.ab +1 -2", ...
      const rest = line.slice(2)
      if (rest.startsWith('branch.head ')) {
        branch = rest.slice('branch.head '.length).trim()
      } else if (rest.startsWith('branch.ab ')) {
        // "+<ahead> -<behind>"
        const m = rest.slice('branch.ab '.length).match(/^\+(\d+)\s+-(\d+)/)
        if (m) {
          ahead = Number(m[1])
          behind = Number(m[2])
        }
      }
      continue
    }
    // Any non-header, non-empty line is a changed/untracked/unmerged entry.
    // Entry-type sigils: '1' ordinary, '2' rename/copy, 'u' unmerged, '?' untracked.
    const sigil = line[0]
    if (sigil === '1' || sigil === '2' || sigil === 'u' || sigil === '?') dirtyCount++
  }

  return { branch, ahead, behind, dirtyCount }
}

/** True iff a status summary reports a detached HEAD (branch.head is the literal
 *  "(detached)"). Kept separate so callers can label the badge. */
export function isDetached(summary: GitStatusSummary): boolean {
  return summary.branch === '(detached)'
}

/** Structured summary of a `git diff --stat` footer. */
export interface DiffStatSummary {
  filesChanged: number
  insertions: number
  deletions: number
}

/** Parse the summary footer of `git diff --stat` output, e.g.
 *    " 3 files changed, 12 insertions(+), 4 deletions(-)"
 *  (singular "1 file changed"; insertions/deletions each optional). Returns all
 *  zeros when no summary line is present (clean tree / no stat). Pure — tested on
 *  fixture strings. */
export function parseDiffStat(stat: string): DiffStatSummary {
  const out: DiffStatSummary = { filesChanged: 0, insertions: 0, deletions: 0 }
  // The footer is the last non-empty line containing "file(s) changed".
  const lines = stat
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const footer = [...lines].reverse().find((l) => /files?\s+changed/.test(l))
  if (!footer) return out
  const files = footer.match(/(\d+)\s+files?\s+changed/)
  const ins = footer.match(/(\d+)\s+insertions?\(\+\)/)
  const del = footer.match(/(\d+)\s+deletions?\(-\)/)
  if (files) out.filesChanged = Number(files[1])
  if (ins) out.insertions = Number(ins[1])
  if (del) out.deletions = Number(del[1])
  return out
}

// ---------------------------------------------------------------------------
// Git invocation (execFile, no shell; -C confines every call to the repo root)
// ---------------------------------------------------------------------------

/** Whether `dir` is inside a git work tree. Non-repos return false (never throw)
 *  so the caller can degrade gracefully — the badge/diff simply stay empty. */
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    const { stdout } = await pexec('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'])
    return stdout.trim() === 'true'
  } catch {
    return false
  }
}

/** Read a GitStatusSummary for the repo at `dir`, or null when `dir` is not a
 *  git repo (or git is unavailable). Never throws. */
export async function gitStatusSummary(dir: string): Promise<GitStatusSummary | null> {
  if (!(await isGitRepo(dir))) return null
  try {
    const { stdout } = await pexec('git', ['-C', dir, 'status', '--porcelain=v2', '--branch'])
    return parseStatusPorcelainV2(stdout)
  } catch {
    return null
  }
}

/** Read the working-tree diff for the repo at `dir` as a GitDiff (stat summary +
 *  a bounded unified patch). Returns null for non-repos. The patch is capped at
 *  DIFF_CAP_BYTES; when the real diff is larger, `truncated` is true and `patch`
 *  holds the first cap bytes. Diffs against HEAD when a commit exists (so staged
 *  AND unstaged edits show); on an unborn branch there is no HEAD, so the plain
 *  working-tree diff is used. */
export async function gitWorkingDiff(dir: string): Promise<GitDiff | null> {
  if (!(await isGitRepo(dir))) return null

  const hasHead = await headExists(dir)
  const revArgs = hasHead ? ['HEAD'] : []

  let stat = ''
  try {
    const { stdout } = await pexec('git', ['-C', dir, 'diff', '--stat', ...revArgs], {
      maxBuffer: 64 * 1024 * 1024
    })
    stat = stdout
  } catch {
    stat = ''
  }

  let patch = ''
  let truncated = false
  try {
    // Capture the full diff into a generous buffer, then bound the STRING (not
    // just the pipe) so `truncated` reflects the real byte length.
    const { stdout } = await pexec('git', ['-C', dir, 'diff', ...revArgs], {
      maxBuffer: 64 * 1024 * 1024
    })
    if (Buffer.byteLength(stdout, 'utf8') > DIFF_CAP_BYTES) {
      truncated = true
      patch = sliceToBytes(stdout, DIFF_CAP_BYTES)
    } else {
      patch = stdout
    }
  } catch {
    // A diff too large even for the 64MB buffer, or any git failure: surface a
    // truncated-empty result rather than throwing.
    truncated = true
    patch = ''
  }

  return { stat, patch, truncated }
}

/** Whether the repo has at least one commit (HEAD resolves). */
async function headExists(dir: string): Promise<boolean> {
  try {
    await pexec('git', ['-C', dir, 'rev-parse', '--verify', '--quiet', 'HEAD'])
    return true
  } catch {
    return false
  }
}

/** Slice a string to at most `maxBytes` UTF-8 bytes without splitting a
 *  multi-byte character (trims back to a codepoint boundary). */
export function sliceToBytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8')
  if (buf.length <= maxBytes) return s
  let end = maxBytes
  // Back off until we're not in the middle of a UTF-8 continuation byte (10xxxxxx).
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
  return buf.toString('utf8', 0, end)
}
