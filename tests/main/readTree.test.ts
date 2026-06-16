import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
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
