import { existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import type { Project } from '@shared/types'
import { cloneRepo, cloneUrl, repoNameFromUrl } from './github'

/** Stable-ish project id from a name (kebab). */
export function projectId(name: string): string {
  return `proj-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}`
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
    id: projectId(repoShortName(repo)),
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
    id: projectId(name),
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
  return { id: projectId(name), name, repo: url, localPath, hasDevcontainer: detectDevcontainer(localPath) }
}
