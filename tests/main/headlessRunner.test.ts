import { describe, it, expect, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { claudeHeadlessArgv, createCliHeadlessRunner, ticketCmdOverride } from '../../src/main/headlessRunner'

// B1: the real headless runner — one confined `claude -p` pass per prompt.
// Confinement is FLAG-ENFORCED (deterministic), not model behavior: all tools
// off, no user/project settings, no MCP, no session persistence.

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdinData = ''
  killedWith: string | null = null
  stdin = {
    on: () => {},
    end: (data: string) => { this.stdinData = data }
  }
  kill(sig: string) { this.killedWith = sig }
}

function fakeSpawnRecorder() {
  const calls: { cmd: string; args: string[]; cwd: string }[] = []
  let child: FakeChild
  const spawn = ((cmd: string, args: string[], opts: { cwd: string }) => {
    calls.push({ cmd, args, cwd: opts.cwd })
    child = new FakeChild()
    return child
  }) as unknown as typeof import('node:child_process').spawn
  return { calls, spawn, child: () => child! }
}

afterEach(() => { delete process.env.AGENT_IDE_TICKET_CMD })

describe('claudeHeadlessArgv (confinement is in the argv)', () => {
  it('disables all tools, settings sources, MCP, and session persistence', () => {
    const { cmd, args } = claudeHeadlessArgv()
    expect(cmd).toBe('claude')
    expect(args).toEqual(['-p', '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence'])
  })
})

describe('ticketCmdOverride', () => {
  it('parses a JSON argv array', () => {
    expect(ticketCmdOverride({ AGENT_IDE_TICKET_CMD: '["node","fixture.js"]' })).toEqual(['node', 'fixture.js'])
  })
  it('returns null when unset', () => {
    expect(ticketCmdOverride({})).toBeNull()
  })
  it('throws on malformed values instead of running something unexpected', () => {
    expect(() => ticketCmdOverride({ AGENT_IDE_TICKET_CMD: 'claude -p' })).toThrow()
    expect(() => ticketCmdOverride({ AGENT_IDE_TICKET_CMD: '[1,2]' })).toThrow()
  })
})

describe('createCliHeadlessRunner', () => {
  it('spawns claude with the prompt on stdin, in a fresh work dir, and resolves stdout', async () => {
    const { calls, spawn, child } = fakeSpawnRecorder()
    const runner = createCliHeadlessRunner({ spawn, mkWorkDir: () => '/tmp/fresh-dir', timeoutMs: 5000 })
    const p = runner('summarize this transcript')
    expect(calls).toHaveLength(1)
    expect(calls[0].cmd).toBe('claude')
    expect(calls[0].cwd).toBe('/tmp/fresh-dir')
    expect(child().stdinData).toBe('summarize this transcript') // stdin, not argv (ARG_MAX)
    child().stdout.emit('data', Buffer.from('{"title":"t"}'))
    child().emit('close', 0)
    await expect(p).resolves.toBe('{"title":"t"}')
  })

  it('rejects with stderr context on a non-zero exit', async () => {
    const { spawn, child } = fakeSpawnRecorder()
    const runner = createCliHeadlessRunner({ spawn, mkWorkDir: () => '/tmp/d', timeoutMs: 5000 })
    const p = runner('x')
    child().stderr.emit('data', Buffer.from('not logged in'))
    child().emit('close', 1)
    await expect(p).rejects.toThrow(/exited 1: not logged in/)
  })

  it('rejects helpfully when the CLI is missing', async () => {
    const { spawn, child } = fakeSpawnRecorder()
    const runner = createCliHeadlessRunner({ spawn, mkWorkDir: () => '/tmp/d', timeoutMs: 5000 })
    const p = runner('x')
    child().emit('error', new Error('spawn claude ENOENT'))
    await expect(p).rejects.toThrow(/is the claude CLI installed/)
  })

  it('kills and rejects on timeout', async () => {
    const { spawn, child } = fakeSpawnRecorder()
    const runner = createCliHeadlessRunner({ spawn, mkWorkDir: () => '/tmp/d', timeoutMs: 10 })
    const p = runner('x')
    await expect(p).rejects.toThrow(/timed out/)
    expect(child().killedWith).toBe('SIGKILL')
  })

  it('honors the AGENT_IDE_TICKET_CMD override (e2e determinism seam)', async () => {
    process.env.AGENT_IDE_TICKET_CMD = '["node","/tmp/fixture.js","--ok"]'
    const { calls, spawn, child } = fakeSpawnRecorder()
    const runner = createCliHeadlessRunner({ spawn, mkWorkDir: () => '/tmp/d', timeoutMs: 5000 })
    const p = runner('x')
    expect(calls[0].cmd).toBe('node')
    expect(calls[0].args).toEqual(['/tmp/fixture.js', '--ok'])
    child().stdout.emit('data', Buffer.from('ok'))
    child().emit('close', 0)
    await expect(p).resolves.toBe('ok')
  })
})
