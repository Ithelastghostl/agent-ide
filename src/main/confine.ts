import { lstatSync, realpathSync } from 'node:fs'
import { join, resolve, relative, isAbsolute, dirname, basename } from 'node:path'

// Path confinement shared by the project file IPC (B1/B2) and the library reader
// (L1). Extracted here so both use the SAME symlink-hardened check without the
// library module depending on ipc.ts (which pulls in Electron). No Electron deps.

/** True iff a path component exists as its OWN filesystem entry — a real file/dir
 *  OR a symlink (dangling or not). Uses lstatSync, which (unlike existsSync) does
 *  NOT follow the link, so a dangling symlink counts as "exists here". */
function lexists(p: string): boolean {
  try { lstatSync(p); return true } catch { return false }
}

/** realpath of `p` if it exists, else the realpath of its deepest existing
 *  ancestor with the not-yet-existing tail re-appended. Lets us confine a target
 *  that doesn't exist yet (a new file being written) while still resolving any
 *  symlinks along the part of the path that IS real.
 *
 *  Returns null when a component that exists is a symlink we can't safely resolve
 *  (a DANGLING symlink — realpathSync throws): re-appending its name verbatim
 *  would let a write follow the link OUTSIDE the root (SEC finding — the reason we
 *  use lstat, not existsSync, which follows links and reports a dangling one as
 *  "missing"). Falls back to `p` verbatim only when nothing on the path exists at
 *  all (e.g. a wholly-synthetic test root). */
export function realpathAllowingMissing(p: string): string | null {
  let existing = p
  const tail: string[] = []
  // walk up until we hit a path component that exists as its OWN entry (lstat).
  while (!lexists(existing)) {
    const parent = dirname(existing)
    if (parent === existing) return p // reached filesystem root without existing — no real part
    tail.unshift(basename(existing))
    existing = parent
  }
  try {
    // realpathSync resolves symlinks; it THROWS if `existing` is a dangling
    // symlink → refuse (null) rather than trust an unresolved link name.
    const real = realpathSync.native(existing)
    return tail.length ? join(real, ...tail) : real
  } catch {
    return null // dangling symlink (or unreadable) at the deepest existing entry
  }
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
  //    A null here means a dangling symlink on the path — refuse (SEC finding).
  const realRoot = realpathAllowingMissing(r)
  const realTarget = realpathAllowingMissing(t)
  if (realRoot === null || realTarget === null) return null
  const realRel = relative(realRoot, realTarget)
  if (realRel === '' || realRel.startsWith('..') || isAbsolute(realRel)) return null

  return realTarget
}
