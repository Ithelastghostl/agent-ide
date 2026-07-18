import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'

const pexec = promisify(execFile)

// The uniform Discussion → Playback → Fix harness (P0.D). Every provider session
// gets this as a trusted primer section, and it is copied into containers at a
// root-owned path so an in-container agent can read but not rewrite it.

export const CONTAINER_HARNESS_DIR = '/opt/agent-ide'
export const CONTAINER_HARNESS_PATH = `${CONTAINER_HARNESS_DIR}/HARNESS.md`

/** Host location of the editable harness file. AGENT_IDE_HARNESS overrides for tests. */
export function harnessPath(): string {
  const dir = process.env.AGENT_IDE_HARNESS || join(homedir(), 'AgentIDE', 'harness')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'HARNESS.md')
}

export const DEFAULT_HARNESS = `# Agent IDE — session harness

You are running inside Nacho's IDE. Every coding session follows one protocol,
regardless of which model you are. Announce which stage you are in.

## Discussion
Explore the task in chat. Ask questions, surface alternatives and risks. Do NOT
edit files or run state-changing commands yet.

## Playback
Restate the goal, scope, the exact actions you will take, and how you will
verify. Wait for the user to approve before proceeding.

## Fix
Only after approval: implement, verify with evidence, and report plainly. If
tests fail, say so.

## Filing backlog work
To propose an epic or goal for this project, write a markdown file into
\`backlog/inbox/\` at the project root with frontmatter:

    ---
    kind: epic        # or: goal | task
    title: Short title
    parent: (optional parent title)
    ---
    Body describing the work.

The IDE ingests these into the project backlog automatically.
`

/** Read the harness text, creating it from the embedded default on first use. */
export function readHarness(): string {
  const p = harnessPath()
  if (!existsSync(p)) writeFileSync(p, DEFAULT_HARNESS, 'utf8')
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return DEFAULT_HARNESS
  }
}

export function writeHarness(text: string): { ok?: true; error?: string } {
  try {
    writeFileSync(harnessPath(), text, 'utf8')
    return { ok: true }
  } catch (err) {
    return { error: (err as Error).message }
  }
}

/** Provision the harness into a container at a ROOT-OWNED path (R30-2/R4-3): a
 *  non-root session can read but never unlink/rewrite it. Creates + validates the
 *  parent dir first (refuse a symlinked/non-root parent), then docker cp +
 *  chown root:root + chmod. Best-effort: failures are logged, not fatal. */
export async function provisionHarnessInContainer(
  containerId: string,
  hostHarnessPath = harnessPath()
): Promise<{ ok: boolean; error?: string }> {
  try {
    // 1. create + validate the parent dir as root
    await pexec('docker', [
      'exec',
      '-u',
      'root',
      containerId,
      'sh',
      '-c',
      `mkdir -p ${CONTAINER_HARNESS_DIR}`
    ])
    const { stdout } = await pexec('docker', [
      'exec',
      '-u',
      'root',
      containerId,
      'sh',
      '-c',
      `[ -L ${CONTAINER_HARNESS_DIR} ] && echo SYMLINK; stat -c '%U' ${CONTAINER_HARNESS_DIR} 2>/dev/null || echo unknown`
    ])
    if (stdout.includes('SYMLINK')) return { ok: false, error: 'container harness dir is a symlink' }
    // 2. copy + lock down
    await pexec('docker', ['cp', hostHarnessPath, `${containerId}:${CONTAINER_HARNESS_PATH}`])
    await pexec('docker', [
      'exec',
      '-u',
      'root',
      containerId,
      'sh',
      '-c',
      `chown -R root:root ${CONTAINER_HARNESS_DIR} && chmod 0755 ${CONTAINER_HARNESS_DIR} && chmod 0444 ${CONTAINER_HARNESS_PATH}`
    ])
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
