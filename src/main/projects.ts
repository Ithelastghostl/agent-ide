import { existsSync, realpathSync } from 'node:fs'
import { join, basename, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import type { Project } from '@shared/types'
import { cloneRepo, cloneUrl, repoNameFromUrl } from './github'

/** Canonical identity of a project: its remote (preferred) or, for a local-only
 *  folder, its absolute path. B7: two repos that share a basename (owner1/app vs
 *  owner2/app) — or a repo vs a local folder both named `app` — must NOT map to
 *  the same id, so we key on full identity, not the display name. A remote is
 *  location-independent (same repo cloned twice = one project); a local folder is
 *  keyed by its real path. */
export function projectKey(repo: string, localPath: string): string {
  if (repo && repo.trim()) {
    const norm = repo
      .trim()
      .toLowerCase()
      .replace(/\.git$/, '')
      .replace(/\/+$/, '')
    return `repo:${norm}`
  }
  let p = resolve(localPath)
  try {
    p = realpathSync.native(p)
  } catch {
    /* path may not exist yet — use resolved */
  }
  return `path:${p}`
}

/** Durable project id: a hash of the project's canonical identity (B7). Stable
 *  across clone location and app restarts; collision-free for distinct projects. */
export function projectId(repo: string, localPath: string): string {
  const key = projectKey(repo, localPath)
  return `proj-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`
}

/** Root under which all projects are cloned. */
export function projectsRoot(): string {
  return join(homedir(), 'AgentIDE')
}

/** Short repo name from owner/name. */
export function repoShortName(repo: string): string {
  return repo.split('/').pop() ?? repo
}

/** Local clone path for a repo under a root. */
export function localPathFor(root: string, repo: string): string {
  return join(root, repoShortName(repo))
}

/** Detect a devcontainer the way VS Code does: .devcontainer/devcontainer.json
 *  or a root .devcontainer.json. */
export function detectDevcontainer(localPath: string): boolean {
  return (
    existsSync(join(localPath, '.devcontainer', 'devcontainer.json')) ||
    existsSync(join(localPath, '.devcontainer.json'))
  )
}

/** Build a Project record for a repo cloned at localPath. */
export function projectFromRepo(repo: string, localPath: string): Project {
  return {
    id: projectId(repo, localPath),
    name: repoShortName(repo),
    repo,
    localPath,
    hasDevcontainer: detectDevcontainer(localPath)
  }
}

/** Build a Project record for an existing local folder (no remote tracked). */
export function projectFromPath(localPath: string): Project {
  const name = basename(localPath.replace(/\/+$/, '')) || 'project'
  return {
    id: projectId('', localPath),
    name,
    repo: '',
    localPath,
    hasDevcontainer: detectDevcontainer(localPath)
  }
}

/** Clone (if needed) a gh repo and return its Project.
 *  `parentDir` is where to place the clone (defaults to ~/AgentIDE). */
export async function addProject(repo: string, parentDir = projectsRoot()): Promise<Project> {
  const localPath = localPathFor(parentDir, repo)
  if (!existsSync(localPath)) {
    await cloneRepo(repo, localPath)
  }
  return projectFromRepo(repo, localPath)
}

/** Open an existing local folder as a project. */
export function openLocalProject(localPath: string): Project {
  return projectFromPath(localPath)
}

/** Clone any git URL into parentDir/<name> and return its Project. */
export async function addProjectFromUrl(url: string, parentDir: string): Promise<Project> {
  const name = repoNameFromUrl(url)
  const localPath = join(parentDir, name)
  if (!existsSync(localPath)) {
    await cloneUrl(url, localPath)
  }
  return {
    id: projectId(url, localPath),
    name,
    repo: url,
    localPath,
    hasDevcontainer: detectDevcontainer(localPath)
  }
}
