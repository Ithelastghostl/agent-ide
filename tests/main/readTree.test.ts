import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTree, readDir, confinedPath } from '../../src/main/ipc'

describe('readTree', () => {
  it('lists the top level only (dirs first, then files), skipping .git', () => {
    const root = mkdtempSync(join(tmpdir(), 'agide-tree-'))
    mkdirSync(join(root, '.git'))
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'index.ts'), '')
    writeFileSync(join(root, 'README.md'), '')

    const tree = readTree(root)
    const names = tree.map((n) => n.name)
    expect(names).not.toContain('.git')
    expect(names).toEqual(['src', 'README.md']) // dir before file, alpha
    expect(tree.every((n) => n.depth === 0)).toBe(true)
    // children are NOT pre-flattened anymore (lazy via fs:dir)
    expect(names).not.toContain('index.ts')

    rmSync(root, { recursive: true, force: true })
  })

  it('returns [] for a missing directory', () => {
    expect(readTree('/no/such/dir/xyz')).toEqual([])
  })
})

describe('readDir', () => {
  it('returns the immediate children of a subdirectory', () => {
    const root = mkdtempSync(join(tmpdir(), 'agide-dir-'))
    mkdirSync(join(root, 'src'))
    mkdirSync(join(root, 'src', 'lib'))
    writeFileSync(join(root, 'src', 'index.ts'), '')

    const kids = readDir(join(root, 'src')).map((n) => n.name)
    expect(kids).toEqual(['lib', 'index.ts']) // dir first
    rmSync(root, { recursive: true, force: true })
  })
})

describe('confinedPath', () => {
  it('resolves a child path inside the project root', () => {
    expect(confinedPath('/proj', 'src/index.ts')).toBe('/proj/src/index.ts')
  })
  it('rejects escaping the root via ..', () => {
    expect(confinedPath('/proj', '../secret')).toBeNull()
    expect(confinedPath('/proj', '../../etc/passwd')).toBeNull()
  })
  it('rejects an absolute path outside the root', () => {
    expect(confinedPath('/proj', '/etc/passwd')).toBeNull()
  })
  it('rejects the root itself (no file to read there)', () => {
    expect(confinedPath('/proj', '')).toBeNull()
    expect(confinedPath('/proj', '.')).toBeNull()
  })
})

// B2 (High): confinedPath was lexical-only, so a symlink *inside* the project
// root pointing outside it slipped through — the resolved string looked confined
// while the real file lived elsewhere on the host. The fix resolves symlinks
// (realpath) on the root and the target's deepest existing ancestor, then checks
// containment against the *real* root. These tests use real filesystem symlinks.
describe('confinedPath symlink hardening (B2)', () => {
  it('rejects a symlink inside the root that points outside it', () => {
    const base = mkdtempSync(join(tmpdir(), 'agide-b2-'))
    const root = join(base, 'project')
    const outside = join(base, 'outside')
    mkdirSync(root)
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 'top secret')
    // an evil symlink in the repo: project/escape -> ../outside
    symlinkSync(outside, join(root, 'escape'))

    // lexically 'escape/secret.txt' is inside root; really it's in ../outside
    expect(confinedPath(root, 'escape/secret.txt')).toBeNull()
    // even pointing the symlink dir itself must be refused as a target
    expect(confinedPath(root, 'escape')).toBeNull()

    rmSync(base, { recursive: true, force: true })
  })

  it('rejects a symlinked file inside the root that targets an outside file', () => {
    const base = mkdtempSync(join(tmpdir(), 'agide-b2f-'))
    const root = join(base, 'project')
    const outside = join(base, 'outside')
    mkdirSync(root)
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 'top secret')
    symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt')) // file symlink out

    expect(confinedPath(root, 'link.txt')).toBeNull()
    rmSync(base, { recursive: true, force: true })
  })

  it('still allows a real path inside the root, and a not-yet-existing new file', () => {
    const base = mkdtempSync(join(tmpdir(), 'agide-b2ok-'))
    const root = join(base, 'project')
    mkdirSync(root)
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'index.ts'), '')
    const real = realpathSync.native(root) // tmpdir itself may be symlinked (/tmp, macOS /var)

    // existing file resolves to the real root's child
    expect(confinedPath(root, 'src/index.ts')).toBe(join(real, 'src', 'index.ts'))
    // a file that doesn't exist yet (file:write creating it) is still allowed —
    // we can only realpath the existing ancestor, not the target itself
    expect(confinedPath(root, 'src/new-file.ts')).toBe(join(real, 'src', 'new-file.ts'))
    expect(confinedPath(root, 'brand/new/deep.ts')).toBe(join(real, 'brand', 'new', 'deep.ts'))

    rmSync(base, { recursive: true, force: true })
  })

  it('allows a symlink inside the root that stays inside the root', () => {
    const base = mkdtempSync(join(tmpdir(), 'agide-b2in-'))
    const root = join(base, 'project')
    mkdirSync(root)
    mkdirSync(join(root, 'real'))
    writeFileSync(join(root, 'real', 'ok.txt'), 'fine')
    symlinkSync(join(root, 'real'), join(root, 'alias')) // internal symlink
    const realRoot = realpathSync.native(root)

    expect(confinedPath(root, 'alias/ok.txt')).toBe(join(realRoot, 'real', 'ok.txt'))
    rmSync(base, { recursive: true, force: true })
  })
})
