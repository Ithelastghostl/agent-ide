import { describe, it, expect } from 'vitest'
import { launchArgv, FORBIDDEN_FLAGS } from '../../src/main/providers'
import { PROVIDERS } from '@shared/types'

describe('launchArgv — subscription interactive only (NN0)', () => {
  it('claude: --model, interactive, no headless/API-key flags', () => {
    const { cmd, args } = launchArgv({ provider: 'claude', model: 'claude-opus-4-8', autoApprove: false })
    expect(cmd).toBe('claude')
    expect(args).toContain('--model')
    expect(args).toContain('claude-opus-4-8')
    expect(args).not.toContain('-p')
    expect(args).not.toContain('--print')
    expect(args).not.toContain('--bare')
  })

  it('codex: -m model, interactive (not exec)', () => {
    const { cmd, args } = launchArgv({ provider: 'codex', model: 'gpt-5-codex', autoApprove: false })
    expect(cmd).toBe('codex')
    expect(args).toContain('-m')
    expect(args).toContain('gpt-5-codex')
    expect(args).not.toContain('exec')
  })

  it('gemini: -m model, interactive (no -p)', () => {
    const { cmd, args } = launchArgv({ provider: 'gemini', model: 'gemini-2.5-pro', autoApprove: false })
    expect(cmd).toBe('gemini')
    expect(args).toContain('-m')
    expect(args).toContain('gemini-2.5-pro')
    expect(args).not.toContain('-p')
    expect(args).not.toContain('--prompt')
  })

  it('autoApprove adds each provider auto-accept flag', () => {
    expect(launchArgv({ provider: 'claude', model: 'x', autoApprove: true }).args).toContain('--dangerously-skip-permissions')
    expect(launchArgv({ provider: 'gemini', model: 'x', autoApprove: true }).args).toContain('--yolo')
    expect(launchArgv({ provider: 'codex', model: 'x', autoApprove: true }).args).toContain('--dangerously-bypass-approvals-and-sandbox')
  })

  it('NEVER emits a forbidden (API-key/headless) flag for any provider, autoApprove on or off', () => {
    for (const provider of PROVIDERS) {
      for (const autoApprove of [false, true]) {
        const { args } = launchArgv({ provider, model: 'm', autoApprove })
        for (const bad of FORBIDDEN_FLAGS) {
          expect(args, `${provider} autoApprove=${autoApprove} must not contain ${bad}`).not.toContain(bad)
        }
      }
    }
  })
})
