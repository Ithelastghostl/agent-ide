// Secure on-disk token + link storage for Linear accounts (S2, R8-minors/R15).
//
// Layout: <root>/<sha256(accountId)>.json — the raw accountId is NEVER a
// filename. Directory is created 0700; files are written atomically (temp file
// in the same dir → fsync → rename) then chmod 0600. Symlinks are rejected on
// both the directory and the target path (an attacker-planted symlink could
// redirect the write). AGENT_IDE_LINEAR_AUTH overrides the root for tests/e2e.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  unlinkSync,
  existsSync,
  lstatSync,
  openSync,
  fsyncSync,
  closeSync,
  chmodSync,
  readdirSync
} from 'node:fs'
import type { LinearLink } from '@shared/types'
import type { AuthServerMetadata, RegisteredClient } from './oauth'

/** The persisted record for one connected Linear account. */
export interface AccountRecord {
  accountId: string
  workspaceId: string
  /** Auth-server metadata (endpoints) discovered at connect time. */
  meta: AuthServerMetadata
  /** The dynamically-registered client. */
  client: RegisteredClient
  /** Current tokens (rotated on refresh). */
  accessToken: string
  refreshToken?: string
  /** Absolute expiry (ms epoch) computed from expires_in at grant/refresh. */
  expiresAt?: number
  scope?: string
  /** The MCP resource this token is bound to (RFC 8707). */
  resource?: string
  createdAt: number
  updatedAt: number
}

/** Root directory for token files (0700). AGENT_IDE_LINEAR_AUTH overrides. */
export function authRoot(): string {
  return process.env.AGENT_IDE_LINEAR_AUTH || join(homedir(), 'AgentIDE', 'linear')
}

/** sha256(accountId) hex — the on-disk filename stem (no raw id on disk). */
export function accountFileStem(accountId: string): string {
  return createHash('sha256').update(accountId).digest('hex')
}

function accountFilePath(accountId: string): string {
  return join(authRoot(), `${accountFileStem(accountId)}.json`)
}

/** Reject a symlink at `p` (defends against a planted-symlink redirect). */
function assertNotSymlink(p: string): void {
  if (!existsSync(p)) return
  const st = lstatSync(p)
  if (st.isSymbolicLink()) throw new Error(`refusing to use symlinked path`)
}

/** Ensure the auth root exists with 0700 and is not a symlink. */
function ensureRoot(): string {
  const root = authRoot()
  assertNotSymlink(root)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  // mkdirSync's mode is subject to umask; force it.
  try {
    chmodSync(root, 0o700)
  } catch {
    /* best effort on exotic FS */
  }
  return root
}

/** Atomically write `data` to `dest` (same-dir temp → fsync → rename), 0600. */
function atomicWrite(dest: string, data: string): void {
  assertNotSymlink(dest)
  const dir = ensureRoot()
  const tmp = join(dir, `.tmp-${randomBytes(8).toString('hex')}`)
  const fd = openSync(tmp, 'wx', 0o600) // wx fails if the temp already exists
  try {
    writeFileSync(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    chmodSync(tmp, 0o600)
  } catch {
    /* best effort */
  }
  renameSync(tmp, dest)
  try {
    chmodSync(dest, 0o600)
  } catch {
    /* best effort */
  }
}

/** File-backed store of connected Linear accounts. Instances are cheap; state
 *  lives entirely on disk. */
export class LinearTokenStore {
  /** Persist (create or overwrite) an account record. */
  save(rec: AccountRecord): void {
    const dest = accountFilePath(rec.accountId)
    atomicWrite(dest, JSON.stringify({ ...rec, updatedAt: Date.now() }, null, 2))
  }

  /** Load an account record by id, or undefined if not connected. */
  load(accountId: string): AccountRecord | undefined {
    const p = accountFilePath(accountId)
    if (!existsSync(p)) return undefined
    assertNotSymlink(p)
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as AccountRecord
    } catch {
      return undefined
    }
  }

  has(accountId: string): boolean {
    return existsSync(accountFilePath(accountId))
  }

  /** Remove an account's token file (logout). Returns whether a file existed. */
  remove(accountId: string): boolean {
    const p = accountFilePath(accountId)
    if (!existsSync(p)) return false
    assertNotSymlink(p)
    unlinkSync(p)
    return true
  }

  /** All connected account ids (by reading + parsing each file's accountId). */
  list(): AccountRecord[] {
    const root = authRoot()
    if (!existsSync(root)) return []
    const out: AccountRecord[] = []
    for (const name of readdirSync(root)) {
      if (!name.endsWith('.json')) continue
      try {
        const rec = JSON.parse(readFileSync(join(root, name), 'utf8')) as AccountRecord
        if (rec.accountId) out.push(rec)
      } catch {
        /* skip corrupt */
      }
    }
    return out
  }
}

// ---------------------------------------------------------------------------
// Per-project Linear link storage.
//
// The v2 plan calls for projects.linearRef, but the FROZEN projects table (and
// Store) has no such column and no accessor, and store.ts is out of S2's edit
// scope. To honor the "no frozen-file edits" boundary while still persisting the
// LinearLink durably per project, links are stored alongside the token files as
// link-<projectId>.json under the same 0700 root. (Documented deviation.)
// ---------------------------------------------------------------------------
function linkFilePath(projectId: string): string {
  // projectId is a durable hash id; still hash the filename for consistency.
  const stem = createHash('sha256').update(`link:${projectId}`).digest('hex')
  return join(authRoot(), `link-${stem}.json`)
}

export interface StoredLink extends LinearLink {
  projectId: string
  updatedAt: number
}

export class LinearLinkStore {
  set(projectId: string, link: LinearLink): void {
    const dest = linkFilePath(projectId)
    const payload: StoredLink = { ...link, projectId, updatedAt: Date.now() }
    atomicWrite(dest, JSON.stringify(payload, null, 2))
  }

  get(projectId: string): StoredLink | undefined {
    const p = linkFilePath(projectId)
    if (!existsSync(p)) return undefined
    assertNotSymlink(p)
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as StoredLink
    } catch {
      return undefined
    }
  }

  remove(projectId: string): boolean {
    const p = linkFilePath(projectId)
    if (!existsSync(p)) return false
    assertNotSymlink(p)
    unlinkSync(p)
    return true
  }
}
