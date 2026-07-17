import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { modelsFor } from '../../src/main/models'
import { PROVIDERS, type Model } from '@shared/types'

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

// The Codex list is resolved live from the CLI's models_cache.json. Its real
// shape surprised us: models are keyed by `slug` (no `id`), and `priority` is
// INVERTED (smaller = more frontier). Pin that mapping so a cache shape/field
// change can't silently drop us back to the static fallback.
describe('codex model list from cache (AGENT_IDE_CODEX_CACHE seam)', () => {
  // Trimmed real-shape cache, deliberately NOT in priority order (proves we sort).
  const REAL_SHAPE = JSON.stringify({
    models: [
      { slug: 'gpt-5.4', display_name: 'GPT-5.4', visibility: 'list', priority: 16 },
      { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide', priority: 43 },
      { slug: 'gpt-5.4-mini', display_name: 'GPT-5.4-Mini', visibility: 'list', priority: 23 },
      { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', priority: 7 }
    ]
  })

  let dir: string
  // Reset the module registry each case so models.ts's in-memory codexCache
  // doesn't leak a prior fixture, then import fresh.
  const fresh = async () => { vi.resetModules(); return import('../../src/main/models') }

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'agide-models-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs() })

  it('maps slug→id, excludes hidden, tiers by inverted priority', async () => {
    const p = join(dir, 'cache.json'); writeFileSync(p, REAL_SHAPE)
    vi.stubEnv('AGENT_IDE_CODEX_CACHE', p)
    const { modelsFor: mf } = await fresh()
    const codex = mf('codex')
    expect(codex.map((m: Model) => m.id)).toEqual(['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'])
    expect(codex.find((m: Model) => m.id === 'gpt-5.5')!.tier).toBe('max')
    expect(codex.find((m: Model) => m.id === 'gpt-5.4-mini')!.tier).toBe('fast')
    expect(codex.some((m: Model) => m.id === 'codex-auto-review')).toBe(false)
  })

  it('falls back to a static list when the cache is missing (no retired ids)', async () => {
    vi.stubEnv('AGENT_IDE_CODEX_CACHE', join(dir, 'nope.json'))
    const { modelsFor: mf } = await fresh()
    const ids = mf('codex').map((m: Model) => m.id)
    expect(ids).toContain('gpt-5.6-sol')
    expect(ids).not.toContain('gpt-5-codex')
  })

  it('isKnownModel/defaultModel reflect the resolved list', async () => {
    const p = join(dir, 'cache.json'); writeFileSync(p, REAL_SHAPE)
    vi.stubEnv('AGENT_IDE_CODEX_CACHE', p)
    const { defaultModel } = await fresh()
    // isKnownModel lives in validate.ts (single owner); same fresh registry.
    const { isKnownModel } = await import('../../src/main/validate')
    expect(isKnownModel('codex', 'gpt-5.5')).toBe(true)
    expect(isKnownModel('codex', 'gpt-5-codex')).toBe(false)
    expect(defaultModel('codex')).toBe('gpt-5.5')
  })
})
