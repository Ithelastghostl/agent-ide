import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Provider, Model } from '@shared/types'

/** Codex's model line rotates on OpenAI's side (gpt-5-codex* → 5.4/5.5 → 5.6-*),
 *  and a ChatGPT-account login can only launch the models the CLI currently
 *  offers — a stale id gets a 400 ("… not supported when using Codex with a
 *  ChatGPT account"). The Codex CLI already fetches the allowed set to
 *  ~/.codex/models_cache.json, so we read THAT as the source of truth instead of
 *  hardcoding a list that goes stale. Fallback below is only for when the cache
 *  is missing (e.g. a container with no ~/.codex). */
const CODEX_FALLBACK: Model[] = [
  { id: 'gpt-5.6-luna', label: 'gpt-5.6-luna', tier: 'fast' },
  { id: 'gpt-5.6-terra', label: 'gpt-5.6-terra', tier: 'balanced' },
  { id: 'gpt-5.6-sol', label: 'gpt-5.6-sol', tier: 'max' }
]

// The cache identifies a model by `slug` (there is no `id` field); `priority` is
// INVERTED — a smaller number is the more prominent/frontier model (gpt-5.6-sol
// == 1, gpt-5.4-mini == 23). We sort by it ascending so the frontier model is first.
interface CachedModel { slug?: string; id?: string; display_name?: string; visibility?: string; priority?: number }

/** Assign our three tiers over the priority-sorted list: first → max, last →
 *  fast, the rest → balanced. A '*-mini' is always 'fast' regardless of position. */
function tierFor(slug: string, index: number, count: number): Model['tier'] {
  if (/-mini$/.test(slug) || index === count - 1) return 'fast'
  if (index === 0) return 'max'
  return 'balanced'
}

/** Path to the Codex CLI's model cache. AGENT_IDE_CODEX_CACHE overrides it (test
 *  seam, mirrors AGENT_IDE_DB). */
function codexCachePath(): string {
  return process.env.AGENT_IDE_CODEX_CACHE || join(homedir(), '.codex', 'models_cache.json')
}

let codexCache: Model[] | null = null
function readCodexModels(): Model[] {
  if (codexCache) return codexCache
  try {
    const raw = readFileSync(codexCachePath(), 'utf8')
    const parsed = JSON.parse(raw) as { models?: CachedModel[] }
    const listed = (parsed.models ?? [])
      .map((m) => ({ ...m, slug: m.slug ?? m.id }))
      .filter((m): m is CachedModel & { slug: string } => m.visibility === 'list' && !!m.slug)
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
    if (listed.length) {
      codexCache = listed.map((m, i) => ({
        id: m.slug,
        label: m.display_name || m.slug,
        tier: tierFor(m.slug, i, listed.length)
      }))
      return codexCache
    }
  } catch { /* no cache / unreadable — fall through to the static fallback */ }
  codexCache = CODEX_FALLBACK
  return codexCache
}

/** Canonical full per-provider model lists (D3 — full list in the picker).
 *  Codex is resolved live from the CLI cache; the others are stable. */
const STATIC: Record<Exclude<Provider, 'codex'>, Model[]> = {
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
  return p === 'codex' ? readCodexModels() : STATIC[p]
}

export function allModels(): Record<Provider, Model[]> {
  return { codex: readCodexModels(), claude: STATIC.claude, gemini: STATIC.gemini }
}

/** The default model for a provider when a stored one is no longer valid: the
 *  'max' tier if present, else the first listed. */
export function defaultModel(provider: Provider): string {
  const list = modelsFor(provider)
  return (list.find((m) => m.tier === 'max') ?? list[0]).id
}
