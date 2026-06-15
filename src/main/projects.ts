import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Project } from '@shared/types'
import { cloneRepo } from './github'

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
    id: `proj-${repoShortName(repo)}`,
    name: repoShortName(repo),
    repo,
    localPath,
    hasDevcontainer: detectDevcontainer(localPath)
  }
}

/** Clone (if needed) a repo and return its Project. */
export async function addProject(repo: string, root = projectsRoot()): Promise<Project> {
  const localPath = localPathFor(root, repo)
  if (!existsSync(localPath)) {
    await cloneRepo(repo, localPath)
  }
  return projectFromRepo(repo, localPath)
}
