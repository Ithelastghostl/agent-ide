import type { Provider, Model } from '@shared/types'

/** B13: the model registry lives in MAIN (src/main/models.ts) and is served over
 *  IPC via models:all — the renderer no longer hardcodes a duplicate list. We
 *  fetch it once at boot into this cache; modelsFor() then reads it synchronously
 *  so the existing picker call sites are unchanged. When the codex model-cache
 *  work (reads ~/.codex/models_cache.json) lands in main, the renderer inherits
 *  it for free through this same IPC. */
let cache: Record<Provider, Model[]> = { codex: [], claude: [], gemini: [] }

/** Load the model registry from main. Call once at startup, before any picker. */
export async function loadModels(): Promise<void> {
  try {
    cache = await window.agentIDE.modelsAll()
  } catch {
    /* leave cache as-is (empty) — picker will show no models rather than stale ones */
  }
}

export function modelsFor(p: Provider): Model[] {
  return cache[p] ?? []
}
