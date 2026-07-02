import { existsSync, realpathSync } from 'node:fs'
import { join, resolve, relative, isAbsolute, dirname, basename } from 'node:path'

// Path confinement shared by the project file IPC (B1/B2) and the library reader
// (L1). Extracted here so both use the SAME symlink-hardened check without the
// library module depending on ipc.ts (which pulls in Electron). No Electron deps.

/** realpath of `p` if it exists, else the realpath of its deepest existing
 *  ancestor with the not-yet-existing tail re-appended. Lets us confine a target
 *  that doesn't exist yet (a new file being written) while still resolving any
 *  symlinks along the part of the path that IS real. Falls back to `p` verbatim
 *  if nothing on the path exists (e.g. a wholly-synthetic test root). */
export function realpathAllowingMissing(p: string): string {
  let existing = p
  const tail: string[] = []
  // walk up until we hit a path component that exists on disk
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) return p // reached filesystem root without existing — no real part
    tail.unshift(basename(existing))
    existing = parent
  }
  return tail.length ? join(realpathSync.native(existing), ...tail) : realpathSync.native(existing)
}

/** Resolve `target` and confirm it stays inside `root` — rejecting both lexical
 *  (`..`) AND symlink escapes (B1/B2). File reads/writes confined to a tree must
 *  never reach arbitrary host paths. A symlink inside the root pointing outside it
 *  is refused because containment is checked against the *real* (symlink-resolved)
 *  paths. Returns the resolved real absolute path, or null if it would escape. */
export function confinedPath(root: string, target: string): string | null {
  // 1. Cheap lexical check first: rejects '', '.', and '..' escapes and absolute
  //    targets without touching the filesystem.
  const r = resolve(root)
  const t = resolve(root, target)
  const lexRel = relative(r, t)
  if (lexRel === '' || lexRel.startsWith('..') || isAbsolute(lexRel)) return null

  // 2. Symlink-aware check: resolve symlinks on the real root and on the target
  //    (down to its deepest existing ancestor), then confirm real containment.
  const realRoot = realpathAllowingMissing(r)
  const realTarget = realpathAllowingMissing(t)
  const realRel = relative(realRoot, realTarget)
  if (realRel === '' || realRel.startsWith('..') || isAbsolute(realRel)) return null

  return realTarget
}
