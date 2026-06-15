import { describe, it, expect } from 'vitest'
import {
  presenceArgv,
  authStatusArgv,
  loginArgv,
  installArgv,
  classifyHealth,
  type Health
} from '../../src/main/providerHealth'

describe('presenceArgv', () => {
  it('checks the CLI is on PATH', () => {
    expect(presenceArgv('codex')).toEqual({ cmd: 'bash', args: ['-lc', 'command -v codex'] })
    expect(presenceArgv('claude')).toEqual({ cmd: 'bash', args: ['-lc', 'command -v claude'] })
    expect(presenceArgv('gemini')).toEqual({ cmd: 'bash', args: ['-lc', 'command -v gemini'] })
  })
})

describe('authStatusArgv', () => {
  it('returns the real auth-status command per provider', () => {
    expect(authStatusArgv('codex')).toEqual({ cmd: 'codex', args: ['login', 'status'] })
    expect(authStatusArgv('claude')).toEqual({ cmd: 'claude', args: ['auth', 'status'] })
    // gemini has no non-interactive status command
    expect(authStatusArgv('gemini')).toBeNull()
  })
})

describe('loginArgv', () => {
  it('returns the interactive login command per provider', () => {
    expect(loginArgv('codex')).toEqual({ cmd: 'codex', args: ['login'] })
    expect(loginArgv('claude')).toEqual({ cmd: 'claude', args: ['auth', 'login'] })
    // gemini authenticates on first interactive launch
    expect(loginArgv('gemini')).toEqual({ cmd: 'gemini', args: [] })
  })
})

describe('installArgv', () => {
  it('npm-installs the provider package globally', () => {
    expect(installArgv('codex').join(' ')).toContain('@openai/codex')
    expect(installArgv('claude').join(' ')).toContain('@anthropic-ai/claude-code')
    expect(installArgv('gemini').join(' ')).toContain('@google/gemini-cli')
  })
})

describe('classifyHealth', () => {
  it('not-installed when CLI is absent', () => {
    expect(classifyHealth({ present: false, authOk: null })).toBe<Health>('not-installed')
  })
  it('healthy when present and auth ok', () => {
    expect(classifyHealth({ present: true, authOk: true })).toBe<Health>('healthy')
  })
  it('not-logged-in when present but auth failed', () => {
    expect(classifyHealth({ present: true, authOk: false })).toBe<Health>('not-logged-in')
  })
  it('unknown when present but auth uncheckable (e.g. gemini)', () => {
    expect(classifyHealth({ present: true, authOk: null })).toBe<Health>('unknown')
  })
})
