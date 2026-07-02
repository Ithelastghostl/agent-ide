import { describe, it, expect } from 'vitest'
import { resolveProjectFile } from '../../src/main/ipc'

// B1 (Critical): the renderer used to supply the confinement `root` directly, so
// fileRead('/', 'etc/passwd') resolved inside '/' and escaped. The fix: the
// renderer supplies a `projectId`; main resolves the root from its own registry
// (Store) and rejects unknown projects. There is no renderer-controlled root.
describe('resolveProjectFile (B1 confinement by projectId)', () => {
  // A fake main-owned registry: only these projects exist.
  const roots: Record<string, string> = {
    'proj-a': '/home/user/proj-a',
    'proj-b': '/tmp/proj-b'
  }
  const getRoot = (id: string): string | undefined => roots[id]

  it('resolves a child path inside a known project root', () => {
    expect(resolveProjectFile(getRoot, 'proj-a', 'src/index.ts')).toBe('/home/user/proj-a/src/index.ts')
  })

  it('rejects an unknown projectId (not in the registry)', () => {
    expect(resolveProjectFile(getRoot, 'proj-unknown', 'src/index.ts')).toBeNull()
    // even with an innocuous relative path, an unregistered project is refused
    expect(resolveProjectFile(getRoot, '', 'README.md')).toBeNull()
  })

  it('rejects escaping a known root via ..', () => {
    expect(resolveProjectFile(getRoot, 'proj-a', '../secret')).toBeNull()
    expect(resolveProjectFile(getRoot, 'proj-a', '../../etc/passwd')).toBeNull()
  })

  it('rejects an absolute path (the B1 exploit shape) inside a known project', () => {
    // The renderer can no longer pass root='/'; the closest attack is an absolute
    // target, which confinement rejects because it escapes the resolved root.
    expect(resolveProjectFile(getRoot, 'proj-a', '/etc/passwd')).toBeNull()
  })

  it('rejects the root itself (no file there)', () => {
    expect(resolveProjectFile(getRoot, 'proj-a', '')).toBeNull()
    expect(resolveProjectFile(getRoot, 'proj-a', '.')).toBeNull()
  })
})
