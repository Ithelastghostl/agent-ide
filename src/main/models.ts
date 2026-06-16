import type { Provider, Model } from '@shared/types'

/** Canonical full per-provider model lists (D3 — full list in the picker). */
const M: Record<Provider, Model[]> = {
  codex: [
    // ChatGPT-subscription Codex supports the gpt-5-codex* family only; plain
    // 'gpt-5' is API-key-only and Codex rejects it under a ChatGPT account, so
    // it's excluded (sessions are subscription-only — see subscription-billing).
    { id: 'gpt-5-codex-mini', label: 'gpt-5-codex-mini', tier: 'fast' },
    { id: 'gpt-5-codex', label: 'gpt-5-codex', tier: 'balanced' },
    { id: 'gpt-5-codex-max', label: 'gpt-5-codex-max', tier: 'max' }
  ],
  claude: [
    { id: 'claude-haiku-4-5', label: 'claude-haiku-4.5', tier: 'fast' },
    { id: 'claude-sonnet-4-6', label: 'claude-sonnet-4.6', tier: 'balanced' },
    { id: 'claude-opus-4-8', label: 'claude-opus-4.8', tier: 'max' }
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
