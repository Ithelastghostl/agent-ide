import { describe, it, expect } from 'vitest'
import { resolveProjectFile } from '../../src/main/ipc'
import { Store } from '../../src/main/store'

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

// B1, handler side: the fs:tree / fs:dir / file:read / file:write handlers resolve
// the confined root via `(id) => store.getProject(id)?.localPath` — the same
// closure the pure resolver is given. The tests above use a fake registry; this
// block wires the *real* Store to prove the integration: a projectId the Store
// doesn't know yields no root (so the handlers fall back to []/error, never a
// host path), while a registered project resolves and still can't be escaped.
describe('resolveProjectFile with a real Store-backed root (B1 end-to-end)', () => {
  function storeWith(project?: { id: string; localPath: string }): Store {
    const store = new Store(':memory:')
    if (project) {
      store.saveProject({
        id: project.id,
        name: 'app',
        repo: 'me/app',
        localPath: project.localPath,
        hasDevcontainer: false
      })
    }
    // This is exactly the `projectRoot` closure ipc.ts hands to every fs handler.
    return store
  }
  const rootOf = (store: Store) => (id: string): string | undefined => store.getProject(id)?.localPath

  it('refuses a projectId the Store has never seen (the B1 attack: name any project)', () => {
    const getRoot = rootOf(storeWith()) // empty Store — no projects registered
    expect(resolveProjectFile(getRoot, 'proj-a', 'src/index.ts')).toBeNull()
    expect(resolveProjectFile(getRoot, 'proj-a', '/etc/passwd')).toBeNull()
    expect(resolveProjectFile(getRoot, '', 'anything')).toBeNull()
  })

  it('resolves a child inside a registered project but still blocks escape', () => {
    const getRoot = rootOf(storeWith({ id: 'proj-a', localPath: '/home/user/proj-a' }))
    expect(resolveProjectFile(getRoot, 'proj-a', 'src/index.ts')).toBe('/home/user/proj-a/src/index.ts')
    // even a known project can't be walked out of, nor addressed absolutely
    expect(resolveProjectFile(getRoot, 'proj-a', '../../etc/passwd')).toBeNull()
    expect(resolveProjectFile(getRoot, 'proj-a', '/etc/passwd')).toBeNull()
  })
})
