import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The fake OAuth flow can't drive a real browser redirect, so we replace the
// loopback wait with a partial module mock: onReady still runs (registering the
// client + "opening" the browser), then a synthetic code is returned — exactly
// what a real callback would deliver. Everything else in oauth.ts is preserved.
vi.mock('../../src/main/linear/oauth', async () => {
  const actual = await vi.importActual<typeof import('../../src/main/linear/oauth')>(
    '../../src/main/linear/oauth'
  )
  return {
    ...actual,
    awaitLoopbackCode: async (a: { onReady: (port: number, uri: string) => unknown }) => {
      await a.onReady(41234, 'http://127.0.0.1:41234/callback')
      return { code: 'auth-code-xyz', port: 41234 }
    }
  }
})

import { Store } from '../../src/main/store'
import { LinearService, extractIssues, extractState, coerceLink } from '../../src/main/linear/linearService'
import { startFakeLinearServer, type FakeServer } from '../fixtures/fakeLinearServer'

let dir: string
let fake: FakeServer

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agide-linsvc-'))
  process.env.AGENT_IDE_LINEAR_AUTH = dir
  fake = await startFakeLinearServer({ pageSize: 2, totalIssues: 5 })
})
afterEach(async () => {
  await fake.close()
  delete process.env.AGENT_IDE_LINEAR_AUTH
  rmSync(dir, { recursive: true, force: true })
})

function service(store: Store): LinearService {
  // Point discovery at the fake resource by overriding the module constant is
  // not possible; instead we inject the fake endpoint via the resource the token
  // record stores. connect() uses LINEAR_MCP_URL for discovery, so we redirect
  // discovery by monkeypatching fetch to rewrite the well-known host to the fake.
  const realFetch = fetch
  const rewriting: typeof fetch = (async (input: any, init?: any) => {
    let url = typeof input === 'string' ? input : input.url
    if (url.startsWith('https://mcp.linear.app')) {
      url = url
        .replace('https://mcp.linear.app/mcp', `${fake.url}/mcp`)
        .replace('https://mcp.linear.app', fake.url)
    }
    return realFetch(url, init)
  }) as unknown as typeof fetch

  return new LinearService({
    store,
    openExternal: () => true, // pretend the browser opened
    fetch: rewriting
  })
}

async function connectAndLink(store: Store, svc: LinearService): Promise<string> {
  const identity = await svc.connect()
  const r = svc.link('p1', {
    accountId: identity.accountId,
    workspaceId: identity.workspaceId,
    label: 'Team X'
  })
  expect(r).toEqual({ ok: true })
  return identity.accountId
}

function newStore(): Store {
  const store = new Store(':memory:')
  store.saveProject({ id: 'p1', name: 'proj', repo: 'me/p', localPath: '/tmp/p', hasDevcontainer: false })
  return store
}

describe('LinearService — connect + link + pull', () => {
  it('runs the OAuth flow (discovery→DCR→token) and links a project', async () => {
    const store = newStore()
    const svc = service(store)
    await connectAndLink(store, svc)
    expect(fake.state.registrations).toBe(1)
    expect(fake.state.tokenGrants).toBe(1)
    const status = svc.status('p1')
    expect(status.connected).toBe(true)
    expect(status.link?.label).toBe('Team X')
  })

  it('pulls all paginated issues and upserts them as linear-sourced backlog rows', async () => {
    const store = newStore()
    const svc = service(store)
    await connectAndLink(store, svc)
    const res = await svc.pull('p1')
    expect(res).toMatchObject({ ok: true, count: 5 })
    const rows = store.listBacklog('p1')
    expect(rows.length).toBe(5)
    expect(rows.every((r) => r.source === 'linear')).toBe(true)
    expect(rows.every((r) => r.remoteStatus === 'Todo')).toBe(true)
    // idempotent re-pull updates in place (no duplicates)
    await svc.pull('p1')
    expect(store.listBacklog('p1').length).toBe(5)
  })

  it('rejects pull for an unlinked project', async () => {
    const store = newStore()
    const svc = service(store)
    expect(await svc.pull('p1')).toEqual({ error: 'project not linked' })
  })
})

describe('LinearService — writeback preview + idempotency', () => {
  it('previews a state change with the exact target and applies it', async () => {
    const store = newStore()
    const svc = service(store)
    await connectAndLink(store, svc)
    await svc.pull('p1')
    const item = store.listBacklog('p1')[0]

    const preview = await svc.previewWriteback(item.id, { kind: 'done' })
    expect('error' in preview).toBe(false)
    if (!('error' in preview)) {
      expect(preview.action).toBe('done')
      expect(preview.target).toBe('Done')
      expect(preview.alreadySatisfied).toBe(false)
    }

    const res = await svc.applyWriteback(item.id, { kind: 'done' }, 'sess-1')
    expect(res).toMatchObject({ ok: true, outcome: 'applied' })

    // Applying again is a no-op (already in the target state type).
    const again = await svc.applyWriteback(item.id, { kind: 'done' }, 'sess-1')
    expect(again).toMatchObject({ ok: true, outcome: 'noop' })
  })

  it('does not double-post a comment carrying the same session marker', async () => {
    const store = newStore()
    const svc = service(store)
    await connectAndLink(store, svc)
    await svc.pull('p1')
    const item = store.listBacklog('p1')[0]

    const first = await svc.applyWriteback(item.id, { kind: 'comment', text: 'Working on it' }, 'sess-42')
    expect(first).toMatchObject({ ok: true, outcome: 'applied' })
    expect(fake.state.comments.length).toBe(1)
    expect(fake.state.comments[0].body).toContain('Working on it')
    expect(fake.state.comments[0].body).toMatch(/⟦agentide:[0-9a-f]{16}⟧/)

    // Retry with the SAME session → the remote marker lookup finds it → no-op.
    const retry = await svc.applyWriteback(item.id, { kind: 'comment', text: 'Working on it' }, 'sess-42')
    expect(retry).toMatchObject({ ok: true, outcome: 'noop' })
    expect(fake.state.comments.length).toBe(1) // NOT double-posted
  })

  it('refuses writeback on a non-linear item', async () => {
    const store = newStore()
    const svc = service(store)
    await connectAndLink(store, svc)
    const manual = store.createBacklogItem({ projectId: 'p1', kind: 'task', title: 'local' })
    const r = await svc.applyWriteback(manual.item!.id, { kind: 'done' }, 's')
    expect(r).toMatchObject({ outcome: 'error' })
    expect(r.error).toMatch(/not linear-owned/)
  })
})

describe('pure parsing helpers', () => {
  it('extractIssues reads nodes + pagination cursor', () => {
    const res = {
      structuredContent: {
        issues: [{ id: 'a', title: 'A', url: 'u', description: 'd', state: { name: 'Todo' } }],
        pageInfo: { hasNextPage: true, endCursor: '2' }
      }
    }
    const { issues, nextCursor } = extractIssues(res as any)
    expect(issues[0]).toMatchObject({ id: 'a', title: 'A', state: 'Todo' })
    expect(nextCursor).toBe('2')
  })
  it('extractState handles string and object states', () => {
    expect(extractState({ state: 'In Progress' })).toBe('In Progress')
    expect(extractState({ state: { name: 'Done', type: 'completed' } })).toBe('Done')
  })
  it('coerceLink validates required identity fields', () => {
    expect('error' in coerceLink({ workspaceId: 'w' })).toBe(true)
    const ok = coerceLink({ accountId: 'a', workspaceId: 'w' })
    expect('link' in ok && ok.link.label).toBe('w')
  })
})
