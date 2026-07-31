import { describe, it, expect } from 'vitest'
import { launchArgv, resolveEffort, FORBIDDEN_FLAGS } from '../../src/main/providers'
import { PROVIDERS, EFFORTS } from '@shared/types'

// Note: provider "resume" flags (--continue/--last/latest) were removed — the IDE
// owns each session's history and reconnects by launching fresh + replaying a
// primer (see history.ts / session:resume), so resumeArgv no longer exists.

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
    expect(launchArgv({ provider: 'claude', model: 'x', autoApprove: true }).args).toContain(
      '--dangerously-skip-permissions'
    )
    expect(launchArgv({ provider: 'gemini', model: 'x', autoApprove: true }).args).toContain('--yolo')
    expect(launchArgv({ provider: 'codex', model: 'x', autoApprove: true }).args).toContain(
      '--dangerously-bypass-approvals-and-sandbox'
    )
  })

  it('omits any effort flag when no effort is set (CLI keeps its own default)', () => {
    for (const provider of PROVIDERS) {
      const { args } = launchArgv({ provider, model: 'm', autoApprove: false })
      expect(args.join(' '), provider).not.toMatch(/effort/i)
    }
  })

  it('claude: --effort <level>', () => {
    const { args } = launchArgv({ provider: 'claude', model: 'm', autoApprove: false, effort: 'high' })
    expect(args).toContain('--effort')
    expect(args[args.indexOf('--effort') + 1]).toBe('high')
  })

  it('codex: -c model_reasoning_effort overrides config.toml', () => {
    const { args } = launchArgv({ provider: 'codex', model: 'm', autoApprove: false, effort: 'low' })
    expect(args).toContain('-c')
    expect(args).toContain('model_reasoning_effort="low"')
  })

  it('codex: passes max through unclamped (its enum accepts max)', () => {
    const { args } = launchArgv({ provider: 'codex', model: 'm', autoApprove: false, effort: 'max' })
    expect(args).toContain('model_reasoning_effort="max"')
  })

  it('gemini: no effort flag — the CLI has no such concept', () => {
    const { args } = launchArgv({ provider: 'gemini', model: 'm', autoApprove: false, effort: 'max' })
    expect(args.join(' ')).not.toMatch(/effort/i)
    expect(args).toEqual(['-m', 'm'])
  })

  it('every effort level is emitted for claude and codex', () => {
    for (const effort of EFFORTS) {
      expect(launchArgv({ provider: 'claude', model: 'm', autoApprove: false, effort }).args).toContain(effort)
      expect(launchArgv({ provider: 'codex', model: 'm', autoApprove: false, effort }).args).toContain(
        `model_reasoning_effort="${effort}"`
      )
    }
  })

  it('effort never introduces a forbidden flag', () => {
    for (const provider of PROVIDERS) {
      for (const effort of EFFORTS) {
        const { args } = launchArgv({ provider, model: 'm', autoApprove: true, effort })
        for (const bad of FORBIDDEN_FLAGS) {
          expect(args, `${provider}/${effort} must not contain ${bad}`).not.toContain(bad)
        }
      }
    }
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

describe('resolveEffort — the command line outranks everything', () => {
  it('AGENT_IDE_EFFORT wins over a per-session pick', () => {
    expect(resolveEffort('low', { AGENT_IDE_EFFORT: 'max' })).toBe('max')
  })

  it('AGENT_IDE_EFFORT applies when no session effort is set', () => {
    expect(resolveEffort(undefined, { AGENT_IDE_EFFORT: 'high' })).toBe('high')
    expect(resolveEffort(null, { AGENT_IDE_EFFORT: 'high' })).toBe('high')
  })

  it('falls back to the session pick when the env var is absent', () => {
    expect(resolveEffort('medium', {})).toBe('medium')
  })

  it('is undefined when nothing is set — provider CLI keeps its own default', () => {
    expect(resolveEffort(undefined, {})).toBeUndefined()
    expect(resolveEffort(null, {})).toBeUndefined()
  })

  it('accepts case/whitespace variation from a shell export', () => {
    expect(resolveEffort(undefined, { AGENT_IDE_EFFORT: '  HIGH ' })).toBe('high')
  })

  it('ignores an unrecognised env value rather than downgrading the session', () => {
    expect(resolveEffort('high', { AGENT_IDE_EFFORT: 'turbo' })).toBe('high')
    expect(resolveEffort(undefined, { AGENT_IDE_EFFORT: '' })).toBeUndefined()
  })

  it('resolved effort reaches argv end-to-end', () => {
    const effort = resolveEffort('low', { AGENT_IDE_EFFORT: 'xhigh' })
    expect(launchArgv({ provider: 'claude', model: 'm', autoApprove: false, effort }).args).toContain('xhigh')
  })
})
