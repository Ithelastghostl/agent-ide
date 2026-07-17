import { describe, it, expect } from 'vitest'
import { presenceArgv, authStatusArgv, loginArgv, classifyServiceHealth } from '../../src/main/serviceHealth'
import { SERVICES } from '@shared/types'

describe('presenceArgv', () => {
  it('checks the right binary on PATH (github → gh)', () => {
    expect(presenceArgv('github')).toEqual({ cmd: 'bash', args: ['-lc', 'command -v gh'] })
    expect(presenceArgv('vercel')).toEqual({ cmd: 'bash', args: ['-lc', 'command -v vercel'] })
    expect(presenceArgv('supabase')).toEqual({ cmd: 'bash', args: ['-lc', 'command -v supabase'] })
    expect(presenceArgv('resend')).toEqual({ cmd: 'bash', args: ['-lc', 'command -v resend'] })
  })
})

describe('authStatusArgv', () => {
  it('uses each service’s non-interactive auth check', () => {
    expect(authStatusArgv('vercel')).toEqual({ cmd: 'vercel', args: ['whoami'] })
    expect(authStatusArgv('supabase')).toEqual({ cmd: 'supabase', args: ['projects', 'list'] })
    expect(authStatusArgv('github')).toEqual({ cmd: 'gh', args: ['auth', 'status'] })
    expect(authStatusArgv('resend')).toEqual({ cmd: 'resend', args: ['whoami'] })
  })
})

describe('loginArgv', () => {
  it('uses each service’s interactive login command', () => {
    expect(loginArgv('vercel')).toEqual({ cmd: 'vercel', args: ['login'] })
    expect(loginArgv('supabase')).toEqual({ cmd: 'supabase', args: ['login'] })
    expect(loginArgv('github')).toEqual({ cmd: 'gh', args: ['auth', 'login'] })
    expect(loginArgv('resend')).toEqual({ cmd: 'resend', args: ['login'] })
  })
})

describe('classifyServiceHealth', () => {
  it('not-installed when the CLI is absent', () => {
    expect(classifyServiceHealth({ present: false, authOk: null })).toBe('not-installed')
    expect(classifyServiceHealth({ present: false, authOk: true })).toBe('not-installed')
  })
  it('online when present + authed', () => {
    expect(classifyServiceHealth({ present: true, authOk: true })).toBe('online')
  })
  it('not-logged-in when present but auth failed', () => {
    expect(classifyServiceHealth({ present: true, authOk: false })).toBe('not-logged-in')
  })
  it('unknown when present + auth indeterminate', () => {
    expect(classifyServiceHealth({ present: true, authOk: null })).toBe('unknown')
  })
})

describe('SERVICES', () => {
  it('tracks the four target services', () => {
    expect([...SERVICES]).toEqual(['vercel', 'supabase', 'github', 'resend'])
  })
})
