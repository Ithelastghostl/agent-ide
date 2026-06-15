import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTree } from '../../src/main/ipc'

describe('readTree', () => {
  it('lists dirs first then files, with one level of nesting, skipping .git', () => {
    const root = mkdtempSync(join(tmpdir(), 'agide-tree-'))
    mkdirSync(join(root, '.git'))
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'index.ts'), '')
    writeFileSync(join(root, 'README.md'), '')

    const tree = readTree(root)
    const names = tree.map((n) => n.name)
    expect(names).not.toContain('.git')
    // src (dir, depth 0) comes before README.md (file, depth 0)
    expect(tree.find((n) => n.name === 'src')!.dir).toBe(true)
    expect(tree.find((n) => n.name === 'index.ts')!.depth).toBe(1)
    expect(names).toContain('README.md')

    rmSync(root, { recursive: true, force: true })
  })

  it('returns [] for a missing directory', () => {
    expect(readTree('/no/such/dir/xyz')).toEqual([])
  })
})
