import { describe, it, expect } from 'vitest'
import { containerExecArgv, devcontainerUpArgv, parseContainerId, devcontainerBin, claudeConfigMount, codexConfigMount, findContainerArgv, findAnyContainerArgv, parseContainerPresence } from '../../src/main/devcontainer'

describe('findContainerArgv', () => {
  it('filters running containers by the devcontainer local_folder label', () => {
    expect(findContainerArgv('/home/me/AgentIDE/app')).toEqual([
      'ps', '--filter', 'label=devcontainer.local_folder=/home/me/AgentIDE/app',
      '--format', '{{.ID}}', '--no-trunc'
    ])
  })
})

describe('findAnyContainerArgv', () => {
  it('uses -a and includes state', () => {
    expect(findAnyContainerArgv('/ws')).toEqual([
      'ps', '-a', '--filter', 'label=devcontainer.local_folder=/ws',
      '--format', '{{.ID}} {{.State}}', '--no-trunc'
    ])
  })
})

describe('parseContainerPresence', () => {
  it('prefers a running container', () => {
    expect(parseContainerPresence('abc exited\ndef running\n')).toEqual({ state: 'running', id: 'def' })
  })
  it('reports stopped when only a non-running one exists', () => {
    expect(parseContainerPresence('abc exited\n')).toEqual({ state: 'stopped', id: 'abc' })
    expect(parseContainerPresence('xyz created\n')).toEqual({ state: 'stopped', id: 'xyz' })
  })
  it('reports none for empty output', () => {
    expect(parseContainerPresence('')).toEqual({ state: 'none' })
  })
})

describe('devcontainerUpArgv with mounts (F12)', () => {
  it('appends --mount for each extra mount', () => {
    expect(devcontainerUpArgv('/ws', ['type=bind,source=/a,target=/b,readonly'])).toEqual([
      'up', '--workspace-folder', '/ws',
      '--mount', 'type=bind,source=/a,target=/b,readonly'
    ])
  })
  it('no --mount when none given', () => {
    expect(devcontainerUpArgv('/ws')).toEqual(['up', '--workspace-folder', '/ws'])
  })
})

describe('claudeConfigMount', () => {
  it('builds a read-only bind mount of ~/.claude', () => {
    expect(claudeConfigMount('/home/me')).toBe('type=bind,source=/home/me/.claude,target=/root/.claude,readonly')
  })
})

describe('codexConfigMount', () => {
  it('builds a read-only bind mount of ~/.codex (host login -> containerized session)', () => {
    expect(codexConfigMount('/home/me')).toBe('type=bind,source=/home/me/.codex,target=/root/.codex,readonly')
  })
})

describe('devcontainerBin', () => {
  it('resolves the local node_modules binary when present', () => {
    // tests run from agent-ide/, where the local CLI is installed
    expect(devcontainerBin()).toContain('node_modules/.bin/devcontainer')
  })
})

describe('devcontainerUpArgv', () => {
  it('builds `devcontainer up --workspace-folder <ws>`', () => {
    expect(devcontainerUpArgv('/home/me/AgentIDE/app')).toEqual([
      'up',
      '--workspace-folder',
      '/home/me/AgentIDE/app'
    ])
  })
})

describe('parseContainerId', () => {
  it('extracts containerId from devcontainer up JSON', () => {
    const out = '{"outcome":"success","containerId":"abc123def","remoteUser":"node"}'
    expect(parseContainerId(out)).toBe('abc123def')
  })
  it('finds the JSON line among log noise', () => {
    const out = 'building...\nsome log\n{"outcome":"success","containerId":"deadbeef"}\n'
    expect(parseContainerId(out)).toBe('deadbeef')
  })
  it('throws when no containerId present', () => {
    expect(() => parseContainerId('no json here')).toThrow()
  })
})

describe('containerExecArgv', () => {
  it('builds `docker exec -it <id> <cmd> <args...>`', () => {
    expect(containerExecArgv('abc123', 'claude', ['--model', 'claude-opus-4-8'])).toEqual([
      'exec',
      '-it',
      'abc123',
      'claude',
      '--model',
      'claude-opus-4-8'
    ])
  })

  it('supports a working directory via -w', () => {
    expect(containerExecArgv('abc123', 'gemini', ['-m', 'gemini-2.5-pro'], { cwd: '/workspaces/app' })).toEqual([
      'exec',
      '-it',
      '-w',
      '/workspaces/app',
      'abc123',
      'gemini',
      '-m',
      'gemini-2.5-pro'
    ])
  })

  it('omits -it for non-interactive (non-TTY) calls (Codex P2)', () => {
    expect(containerExecArgv('abc123', 'codex', ['login', 'status'], { interactive: false })).toEqual([
      'exec', 'abc123', 'codex', 'login', 'status'
    ])
  })
})
