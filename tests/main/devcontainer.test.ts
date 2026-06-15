import { describe, it, expect } from 'vitest'
import { containerExecArgv, devcontainerUpArgv, parseContainerId, devcontainerBin, claudeConfigMount, findContainerArgv } from '../../src/main/devcontainer'

describe('findContainerArgv', () => {
  it('filters running containers by the devcontainer local_folder label', () => {
    expect(findContainerArgv('/home/me/AgentIDE/app')).toEqual([
      'ps', '--filter', 'label=devcontainer.local_folder=/home/me/AgentIDE/app',
      '--format', '{{.ID}}', '--no-trunc'
    ])
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
    expect(containerExecArgv('abc123', 'gemini', ['-m', 'gemini-2.5-pro'], '/workspaces/app')).toEqual([
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
})
