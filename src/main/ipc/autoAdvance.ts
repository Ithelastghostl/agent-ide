import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'

// Per-project queue autoAdvance flag (S6). The v2 plan puts this on the projects
// table, but the foundation's projects schema + Store are FROZEN and do not carry
// it. Rather than reach into the frozen Store, S6 owns this small flag store: it
// is consumed ONLY at S6's advancement call sites (the 'archived' trigger and the
// enqueue wake-up in ipc/queue.ts), so no other stream depends on it. A plain
// JSON map keyed by projectId, written atomically (tmp + rename). The directory is
// env-overridable for tests (AGENT_IDE_QUEUE), mirroring the harness/history dirs.

function dir(): string {
  const d = process.env.AGENT_IDE_QUEUE || join(homedir(), 'AgentIDE', 'queue')
  mkdirSync(d, { recursive: true })
  return d
}

function file(): string {
  return join(dir(), 'autoAdvance.json')
}

function readAll(): Record<string, boolean> {
  try {
    const raw = readFileSync(file(), 'utf8')
    const obj = JSON.parse(raw)
    return obj && typeof obj === 'object' ? (obj as Record<string, boolean>) : {}
  } catch {
    // absent / unreadable / malformed → default all-off
    return {}
  }
}

/** Whether a project's queue auto-advances on session completion. Default false. */
export function getAutoAdvance(projectId: string): boolean {
  return readAll()[projectId] === true
}

/** Persist a project's autoAdvance flag. Returns the PREVIOUS value so callers can
 *  detect a false→true edge (R21 non-completion wake-up). */
export function setAutoAdvance(projectId: string, on: boolean): boolean {
  const all = readAll()
  const prev = all[projectId] === true
  all[projectId] = on
  const tmp = file() + '.tmp'
  writeFileSync(tmp, JSON.stringify(all), 'utf8')
  renameSync(tmp, file())
  return prev
}
