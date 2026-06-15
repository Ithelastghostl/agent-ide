import { describe, it, expect } from 'vitest'
import { modelsFor } from '../../src/main/models'
import { PROVIDERS } from '@shared/types'

describe('modelsFor', () => {
  it('returns a non-empty list for every provider', () => {
    for (const p of PROVIDERS) {
      const list = modelsFor(p)
      expect(list.length).toBeGreaterThan(0)
      for (const m of list) {
        expect(m).toHaveProperty('id')
        expect(m).toHaveProperty('label')
        expect(['fast', 'balanced', 'max']).toContain(m.tier)
      }
    }
  })

  it('claude list includes haiku, sonnet, opus', () => {
    const ids = modelsFor('claude').map((m) => m.id)
    expect(ids.some((i) => i.includes('haiku'))).toBe(true)
    expect(ids.some((i) => i.includes('sonnet'))).toBe(true)
    expect(ids.some((i) => i.includes('opus'))).toBe(true)
  })
})
