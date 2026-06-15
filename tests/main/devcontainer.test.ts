import { describe, it, expect } from 'vitest'
import { containerExecArgv, devcontainerUpArgv, parseContainerId, devcontainerBin } from '../../src/main/devcontainer'

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
