import type { Provider, Model } from '@shared/types'

/** Canonical full per-provider model lists (D3 — full list in the picker). */
const M: Record<Provider, Model[]> = {
  codex: [
    // Mirrors the CLI's own registry (~/.codex/models_cache.json): the GPT-5.6
    // family replaced gpt-5-codex*, which current Codex no longer lists. Tiers
    // follow the cache descriptions (luna "fast and affordable", terra
    // "balanced for everyday work", sol "latest frontier").
    { id: 'gpt-5.6-luna', label: 'gpt-5.6-luna', tier: 'fast' },
    { id: 'gpt-5.6-terra', label: 'gpt-5.6-terra', tier: 'balanced' },
    { id: 'gpt-5.6-sol', label: 'gpt-5.6-sol', tier: 'max' }
  ],
  claude: [
    { id: 'claude-haiku-4-5', label: 'claude-haiku-4.5', tier: 'fast' },
    { id: 'claude-sonnet-4-6', label: 'claude-sonnet-4.6', tier: 'balanced' },
    { id: 'claude-opus-4-8', label: 'claude-opus-4.8', tier: 'max' },
    { id: 'claude-fable-5', label: 'claude-fable-5', tier: 'max' }
  ],
  gemini: [
    { id: 'gemini-2.5-flash', label: 'gemini-2.5-flash', tier: 'fast' },
    { id: 'gemini-2.5-pro', label: 'gemini-2.5-pro', tier: 'balanced' },
    { id: 'gemini-2.5-deep-think', label: 'gemini-2.5-deep-think', tier: 'max' }
  ]
}

export function modelsFor(p: Provider): Model[] {
  return M[p]
}

export function allModels(): Record<Provider, Model[]> {
  return M
}
