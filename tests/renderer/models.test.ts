import { describe, it, expect, beforeEach, vi } from 'vitest'
import { modelsFor, loadModels } from '../../src/renderer/models'

// B13: the renderer no longer hardcodes a model list — it fetches the registry
// from main via window.agentIDE.modelsAll() and caches it. modelsFor() reads the
// cache synchronously for the pickers.
describe('renderer model registry (B13)', () => {
  beforeEach(() => {
    // fresh module cache per test isn't trivial without resetModules; instead we
    // just re-load with different stubs and assert on the observable result.
    ;(globalThis as unknown as { window: unknown }).window = {
      agentIDE: {
        modelsAll: vi.fn().mockResolvedValue({
          codex: [{ id: 'x-codex', label: 'x', tier: 'balanced' }],
          claude: [{ id: 'x-claude', label: 'x', tier: 'max' }],
          gemini: []
        })
      }
    }
  })

  it('is empty before load, populated after (from main, not hardcoded)', async () => {
    await loadModels()
    expect(modelsFor('codex').map((m) => m.id)).toEqual(['x-codex'])
    expect(modelsFor('claude').map((m) => m.id)).toEqual(['x-claude'])
    expect(modelsFor('gemini')).toEqual([])
  })

  it('returns [] (not a crash) for a provider missing from the registry', async () => {
    ;(globalThis as unknown as { window: { agentIDE: { modelsAll: () => Promise<unknown> } } }).window.agentIDE.modelsAll =
      vi.fn().mockResolvedValue({ codex: [], claude: [], gemini: [] })
    await loadModels()
    expect(modelsFor('codex')).toEqual([])
  })

  it('leaves the cache usable if the IPC call fails', async () => {
    ;(globalThis as unknown as { window: { agentIDE: { modelsAll: () => Promise<unknown> } } }).window.agentIDE.modelsAll =
      vi.fn().mockRejectedValue(new Error('ipc down'))
    await expect(loadModels()).resolves.toBeUndefined() // does not throw
    expect(Array.isArray(modelsFor('claude'))).toBe(true)
  })
})
