import { describe, it, expect } from 'vitest'
import { PROVIDERS, isProvider } from '@shared/types'

describe('providers', () => {
  it('has exactly codex, claude, gemini', () => {
    expect(PROVIDERS).toEqual(['codex', 'claude', 'gemini'])
  })
  it('isProvider narrows correctly', () => {
    expect(isProvider('claude')).toBe(true)
    expect(isProvider('openai')).toBe(false)
  })
})
