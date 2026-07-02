import type { Provider, Model } from '@shared/types'

/** Per-provider model lists for the picker (D3). The source of truth is the main
 *  process (src/main/models.ts) — Codex is resolved live from the CLI's model
 *  cache there, so this file must NOT hardcode a copy (they drift). hydrateModels()
 *  fills this at boot over the models:all IPC; modelsFor() stays synchronous so
 *  the picker call sites don't change. Empty until hydrated. */
let M: Record<Provider, Model[]> = { codex: [], claude: [], gemini: [] }

/** Fetch the model lists from main once at startup. Best-effort: on failure the
 *  lists stay empty and the picker simply shows nothing rather than a stale set. */
export async function hydrateModels(): Promise<void> {
  try {
    M = (await window.agentIDE.modelsAll()) as Record<Provider, Model[]>
  } catch (err) {
    console.error('model hydrate failed', err)
  }
}

export function modelsFor(p: Provider): Model[] {
  return M[p] ?? []
}
