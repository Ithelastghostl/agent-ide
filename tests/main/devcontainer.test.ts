import { describe, it, expect } from 'vitest'
import {
  containerExecArgv,
  devcontainerUpArgv,
  parseContainerId,
  devcontainerBin,
  libraryConfigMount,
  parseRemoteUser,
  findContainerArgv,
  findAnyContainerArgv,
  parseContainerPresence,
  providerSeedFiles,
  seedTarget,
  readConfigurationArgv,
  parseWorkspaceFolder
} from '../../src/main/devcontainer'

describe('findContainerArgv', () => {
  it('filters running containers by the devcontainer local_folder label', () => {
    expect(findContainerArgv('/home/me/AgentIDE/app')).toEqual([
      'ps',
      '--filter',
      'label=devcontainer.local_folder=/home/me/AgentIDE/app',
      '--format',
      '{{.ID}}',
      '--no-trunc'
    ])
  })
})

describe('findAnyContainerArgv', () => {
  it('uses -a and includes state', () => {
    expect(findAnyContainerArgv('/ws')).toEqual([
      'ps',
      '-a',
      '--filter',
      'label=devcontainer.local_folder=/ws',
      '--format',
      '{{.ID}} {{.State}}',
      '--no-trunc'
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
      'up',
      '--workspace-folder',
      '/ws',
      '--mount',
      'type=bind,source=/a,target=/b,readonly'
    ])
  })
  it('no --mount when none given', () => {
    expect(devcontainerUpArgv('/ws')).toEqual(['up', '--workspace-folder', '/ws'])
  })
})

describe('credential seeding (R3-2)', () => {
  // Host creds are docker-cp'd one-way into the container user's writable home
  // — never mounted, so nothing writes back to the host, and in-container
  // logins / token refreshes persist.
  it('providerSeedFiles picks only existing credential files (allowlist, not whole dirs)', () => {
    const present = new Set(['/home/me/.codex/auth.json', '/home/me/.gemini/oauth_creds.json'])
    const files = providerSeedFiles('/home/me', { includeClaude: false }, (p) => present.has(p))
    expect(files).toEqual([
      { hostPath: '/home/me/.codex/auth.json', provider: 'codex', file: 'auth.json' },
      { hostPath: '/home/me/.gemini/oauth_creds.json', provider: 'gemini', file: 'oauth_creds.json' }
    ])
  })
  it('claude files seed only with the importConfig opt-in', () => {
    const exists = () => true
    const withoutClaude = providerSeedFiles('/h', { includeClaude: false }, exists)
    expect(withoutClaude.some((f) => f.provider === 'claude')).toBe(false)
    const withClaude = providerSeedFiles('/h', { includeClaude: true }, exists)
    expect(withClaude.map((f) => f.file)).toContain('.credentials.json')
  })
  it('seedTarget places each file in the provider dot-dir of the resolved home', () => {
    expect(
      seedTarget('/home/node', { hostPath: '/h/.codex/auth.json', provider: 'codex', file: 'auth.json' })
    ).toBe('/home/node/.codex/auth.json')
    expect(
      seedTarget('/root', { hostPath: '/h/.gemini/settings.json', provider: 'gemini', file: 'settings.json' })
    ).toBe('/root/.gemini/settings.json')
  })
  it('libraryConfigMount uses only the mount keys the devcontainer CLI accepts', () => {
    const m = libraryConfigMount('/home/me/AgentIDE/library')
    expect(m).toBe('type=bind,source=/home/me/AgentIDE/library,target=/home/node/.agent-ide/library')
    expect(m).not.toContain('readonly') // rejected by the CLI's --mount grammar
  })
})

describe('container exec context (R3-1)', () => {
  it('readConfigurationArgv asks the devcontainer CLI for the merged config', () => {
    expect(readConfigurationArgv('/ws')).toEqual(['read-configuration', '--workspace-folder', '/ws'])
  })
  it('parseWorkspaceFolder extracts the container-side workspace folder', () => {
    const out = 'log noise\n{"configuration":{},"workspace":{"workspaceFolder":"/workspaces/app"}}'
    expect(parseWorkspaceFolder(out, '/home/me/app')).toBe('/workspaces/app')
  })
  it('parseWorkspaceFolder falls back to the /workspaces/<name> convention', () => {
    expect(parseWorkspaceFolder('', '/home/me/my-app')).toBe('/workspaces/my-app')
  })
  it('containerExecArgv sets HOME via -e (docker exec -u does not)', () => {
    expect(
      containerExecArgv('abc', 'codex', ['login', 'status'], {
        interactive: false,
        user: 'node',
        cwd: '/workspaces/app',
        env: { HOME: '/home/node' }
      })
    ).toEqual([
      'exec',
      '-u',
      'node',
      '-w',
      '/workspaces/app',
      '-e',
      'HOME=/home/node',
      'abc',
      'codex',
      'login',
      'status'
    ])
  })
})

describe('parseRemoteUser', () => {
  it('returns the last remoteUser from devcontainer.metadata', () => {
    const meta = JSON.stringify([{ id: 'a' }, { remoteUser: 'node' }, { id: 'b', remoteUser: 'vscode' }])
    expect(parseRemoteUser(meta)).toBe('vscode')
  })
  it('returns null when no remoteUser is present', () => {
    expect(parseRemoteUser(JSON.stringify([{ id: 'a' }]))).toBeNull()
  })
  it('returns null for missing or unparseable metadata', () => {
    expect(parseRemoteUser(undefined)).toBeNull()
    expect(parseRemoteUser('not json')).toBeNull()
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
    expect(
      containerExecArgv('abc123', 'gemini', ['-m', 'gemini-2.5-pro'], { cwd: '/workspaces/app' })
    ).toEqual(['exec', '-it', '-w', '/workspaces/app', 'abc123', 'gemini', '-m', 'gemini-2.5-pro'])
  })

  it('omits -it for non-interactive (non-TTY) calls (Codex P2)', () => {
    expect(containerExecArgv('abc123', 'codex', ['login', 'status'], { interactive: false })).toEqual([
      'exec',
      'abc123',
      'codex',
      'login',
      'status'
    ])
  })

  it('runs as a specific user via -u (non-root, so auto-approve flags work)', () => {
    expect(
      containerExecArgv('abc123', 'claude', ['--dangerously-skip-permissions'], { user: 'node' })
    ).toEqual(['exec', '-it', '-u', 'node', 'abc123', 'claude', '--dangerously-skip-permissions'])
  })
})
