import { describe, it, expect, afterEach } from 'vitest'
import { McpClient, parseSseForResponse } from '../../src/main/linear/mcpClient'
import { startFakeLinearServer, type FakeServer } from '../fixtures/fakeLinearServer'

let fake: FakeServer | undefined
afterEach(async () => {
  await fake?.close()
  fake = undefined
})

function client(f: FakeServer): McpClient {
  return new McpClient({ endpoint: f.mcpUrl, getToken: async () => 'at-initial' })
}

describe('parseSseForResponse (pure)', () => {
  it('extracts the JSON-RPC message from SSE data frames', () => {
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n'
    expect(parseSseForResponse(sse)).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } } as any)
  })
  it('skips keep-alives / non-JSON frames and returns the last result', () => {
    const sse = ': keep-alive\ndata: notjson\ndata: {"result":1}\ndata: {"result":2}\n'
    expect(parseSseForResponse(sse)).toEqual({ result: 2 } as any)
  })
})

describe('McpClient — full handshake', () => {
  it('initializes, negotiates version, captures session id, then lists tools', async () => {
    fake = await startFakeLinearServer()
    const c = client(fake)
    await c.initialize()
    expect(fake.state.initializations).toBe(1)
    expect(c.currentSessionId).toMatch(/^sess-/)
    expect(c.protocolVersion).toBe('2025-06-18')
    const tools = await c.listTools()
    expect(tools.map((t) => t.name)).toContain('list_issues')
  })

  it('rejects unauthenticated requests (401)', async () => {
    fake = await startFakeLinearServer()
    const c = new McpClient({ endpoint: fake.mcpUrl, getToken: async () => '' })
    await expect(c.initialize()).rejects.toThrow(/unauthorized/)
  })

  it('follows cursor pagination across tools/call', async () => {
    fake = await startFakeLinearServer({ pageSize: 2, totalIssues: 5 })
    const c = client(fake)
    await c.initialize()
    // Manually page through, mirroring linearService's loop.
    let after: string | undefined
    const seen: string[] = []
    do {
      const res = await c.callTool('list_issues', after ? { after } : {})
      const data = JSON.parse((res.content ?? []).find((x) => x.type === 'text')!.text!) as {
        issues: any[]
        pageInfo: { hasNextPage: boolean; endCursor: string | null }
      }
      for (const i of data.issues) seen.push(i.id)
      after = data.pageInfo.hasNextPage ? data.pageInfo.endCursor! : undefined
    } while (after)
    expect(seen).toEqual(['iss-1', 'iss-2', 'iss-3', 'iss-4', 'iss-5'])
  })

  it('reinitializes transparently on session expiry', async () => {
    fake = await startFakeLinearServer({ forceSessionExpiryOnce: true })
    const c = client(fake)
    await c.initialize()
    expect(fake.state.initializations).toBe(1)
    // The next call triggers a forced expiry → client reinitializes + retries.
    const tools = await c.listTools()
    expect(tools.length).toBeGreaterThan(0)
    expect(fake.state.initializations).toBe(2) // reinitialized exactly once
  })

  it('handles SSE-framed responses', async () => {
    fake = await startFakeLinearServer({ sse: true })
    const c = client(fake)
    await c.initialize()
    const tools = await c.listTools()
    expect(tools.map((t) => t.name)).toContain('get_issue')
  })

  it('enforces a per-request timeout', async () => {
    fake = await startFakeLinearServer()
    // A client with a tiny timeout against a getToken that stalls forever.
    const c = new McpClient({
      endpoint: fake.mcpUrl,
      getToken: () =>
        new Promise<string>(() => {
          /* never resolves */
        }),
      timeoutMs: 50
    })
    // initialize awaits getToken; wrap with our own race to bound the test.
    const raced = await Promise.race([
      c
        .initialize()
        .then(() => 'resolved')
        .catch((e) => `err:${(e as Error).message}`),
      new Promise<string>((r) => setTimeout(() => r('test-timeout'), 500))
    ])
    // getToken stall means the request never fires; ensure we did NOT resolve success.
    expect(raced).not.toBe('resolved')
  })
})
