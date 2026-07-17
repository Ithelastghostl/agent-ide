import type { AttentionState, CostSummary, Provider } from '../shared/types'
import { stripAnsi } from './history'
import { parseCostLines, type CostPattern, DEFAULT_COST_PATTERNS } from './cost'

/** Quiet window before a session is flagged (item 19/R20 default 8s). Injectable
 *  via env for e2e (short) and via opts for unit tests. */
export const DEFAULT_QUIET_MS = 8_000
/** One notification per attention EPISODE, and never more than one per this
 *  debounce window across episodes (R20). */
export const NOTIFY_DEBOUNCE_MS = 30_000

/** Needs-input heuristics (R19/R20): applied to the LAST non-empty CLEANED line.
 *  A match means the engine is likely waiting on the user → 'input'; plain quiet
 *  with no match → 'idle'. Kept conservative to bound false positives. */
export const NEEDS_INPUT_PATTERNS: RegExp[] = [
  /\?\s*$/,                                   // trailing question mark
  /\(?\s*y\s*\/\s*n\s*\)?\s*[:?]?\s*$/i,      // (y/n) prompt
  /\[\s*y\s*\/\s*n\s*\]/i,                    // [y/N]
  /\byes\s*\/\s*no\b/i,                       // yes/no
  /\bapprove\b/i,                             // approval gate
  /\bwaiting for (?:your )?input\b/i,         // explicit wait banner
  /\bawaiting (?:your )?(?:input|response|confirmation)\b/i,
  /\bpress\s+enter\b/i,                       // "press Enter to continue"
  /\bdo you want to\b/i,                      // "Do you want to proceed"
  /\bcontinue\?\s*$/i,                        // "Continue?"
  /\bconfirm\b.*\?/i,                         // "Confirm ...?"
  /(?:^|\s)>\s*$/                             // bare prompt caret (provider idle banner)
]

/** True if the cleaned line looks like the engine is waiting for input. */
export function looksLikeNeedsInput(cleanedLine: string): boolean {
  const line = cleanedLine.trim()
  if (!line) return false
  return NEEDS_INPUT_PATTERNS.some((re) => re.test(line))
}

export interface AttentionEmit {
  /** Renderer event: a session's attention flag changed (bridge session:attention). */
  onAttention: (sessionId: string, state: AttentionState) => void
  /** Renderer event: a session's cost summary changed (bridge session:cost). */
  onCost: (sessionId: string) => void
}

export interface AttentionOpts {
  quietMs?: number
  patterns?: Record<Provider, CostPattern[]>
  /** Injected clock (tests). */
  now?: () => number
  /** Whether the app window is currently UNFOCUSED — notify only when true. */
  isUnfocused?: () => boolean
  /** Fire an OS notification (macOS). Injected so tests observe without electron. */
  notify?: (sessionId: string, title: string, body: string) => void
  /** Look up a session's provider (for cost parsing) — main resolves from Store. */
  providerOf?: (sessionId: string) => Provider | undefined
  /** Persist a parsed cost summary (main wires Store). */
  saveCost?: (sessionId: string, cost: CostSummary) => void
}

interface SessionAtt {
  provider?: Provider
  buffer: string            // incomplete trailing line not yet closed by \n
  lastNonEmptyLine: string  // last CLEANED non-empty completed line
  state: AttentionState
  timer: ReturnType<typeof setTimeout> | null
  /** A notification has already fired for the CURRENT episode (quiet→flagged→cleared). */
  notifiedThisEpisode: boolean
  lastNotifyAt: number
  cost: CostSummary | null
}

/** Ephemeral, main-process attention + cost monitor (S5). Subscribes to buffered
 *  session output, flags sessions quiet ≥quietMs (input vs idle), parses cost
 *  summaries, and drives renderer badges + one debounced OS notification per
 *  episode. State is NEVER persisted and is separate from SessionStatus. */
export class AttentionMonitor {
  private sessions = new Map<string, SessionAtt>()
  private readonly quietMs: number
  private readonly patterns: Record<Provider, CostPattern[]>
  private readonly now: () => number
  private readonly isUnfocused: () => boolean
  private readonly notify: (sessionId: string, title: string, body: string) => void
  private readonly providerOf: (sessionId: string) => Provider | undefined
  private readonly saveCost: (sessionId: string, cost: CostSummary) => void

  constructor(private emit: AttentionEmit, opts: AttentionOpts = {}) {
    const envQuiet = Number(process.env.AGENT_IDE_ATTENTION_QUIET_MS)
    this.quietMs = opts.quietMs ?? (Number.isFinite(envQuiet) && envQuiet > 0 ? envQuiet : DEFAULT_QUIET_MS)
    this.patterns = opts.patterns ?? DEFAULT_COST_PATTERNS
    this.now = opts.now ?? Date.now
    this.isUnfocused = opts.isUnfocused ?? (() => false)
    this.notify = opts.notify ?? (() => {})
    this.providerOf = opts.providerOf ?? (() => undefined)
    this.saveCost = opts.saveCost ?? (() => {})
  }

  private get(id: string): SessionAtt {
    let s = this.sessions.get(id)
    if (!s) {
      s = {
        provider: this.providerOf(id),
        buffer: '',
        lastNonEmptyLine: '',
        state: null,
        timer: null,
        notifiedThisEpisode: false,
        lastNotifyAt: Number.NEGATIVE_INFINITY,
        cost: null
      }
      this.sessions.set(id, s)
    }
    if (!s.provider) s.provider = this.providerOf(id)
    return s
  }

  /** Handle a raw output chunk for a session (from sessionEvents 'output'). */
  onOutput(id: string, chunk: string): void {
    const s = this.get(id)
    // New output means the engine is NOT waiting — clear any flag + reset episode.
    this.clearFlag(s, id)

    // Buffer to complete lines: only lines terminated by \n are "closed". The
    // trailing partial stays in the buffer until the next chunk closes it.
    s.buffer += chunk
    const parts = s.buffer.split('\n')
    s.buffer = parts.pop() ?? ''
    const closedRaw = parts

    // Clean each closed line; track the last non-empty for the heuristic, and
    // feed all cleaned closed lines to the cost parser (last-summary-wins).
    const cleaned: string[] = []
    for (const raw of closedRaw) {
      const c = stripAnsi(raw).trim()
      cleaned.push(c)
      if (c) s.lastNonEmptyLine = c
    }
    if (s.provider) {
      const hit = parseCostLines(s.provider, cleaned, this.patterns)
      if (hit) {
        s.cost = hit
        this.saveCost(id, hit)
        this.emit.onCost(id)
      }
    }

    // (Re)arm the quiet timer from the most recent output.
    this.arm(s, id)
  }

  /** Input from the user (pty:write): the engine is being answered → clear flag
   *  and end the episode (no notification until the next quiet→flag cycle). */
  onInput(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    this.clearFlag(s, id)
    // Input also cancels any pending arm — nothing to flag until fresh output.
    if (s.timer) { clearTimeout(s.timer); s.timer = null }
  }

  /** Session ended: drop its ephemeral state and clear any badge. */
  onExit(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    if (s.timer) clearTimeout(s.timer)
    const had = s.state !== null
    this.sessions.delete(id)
    if (had) this.emit.onAttention(id, null)
  }

  /** Current attention map for the renderer (attention:state). Only flagged
   *  sessions appear. */
  stateMap(): Record<string, Exclude<AttentionState, null>> {
    const out: Record<string, Exclude<AttentionState, null>> = {}
    for (const [id, s] of this.sessions) if (s.state) out[id] = s.state
    return out
  }

  /** Last known cost summary for a session, or null. */
  costFor(id: string): CostSummary | null {
    return this.sessions.get(id)?.cost ?? null
  }

  /** Test/shutdown helper: clear all timers. */
  dispose(): void {
    for (const s of this.sessions.values()) if (s.timer) clearTimeout(s.timer)
    this.sessions.clear()
  }

  private arm(s: SessionAtt, id: string): void {
    if (s.timer) clearTimeout(s.timer)
    s.timer = setTimeout(() => this.flag(s, id), this.quietMs)
    // Node timers keep the process alive; a monitor timer must not.
    if (typeof (s.timer as { unref?: () => void }).unref === 'function') {
      (s.timer as { unref: () => void }).unref()
    }
  }

  private flag(s: SessionAtt, id: string): void {
    s.timer = null
    const next: AttentionState = looksLikeNeedsInput(s.lastNonEmptyLine) ? 'input' : 'idle'
    if (s.state === next) return
    s.state = next
    this.emit.onAttention(id, next)
    // Notify at most once per episode, debounced, only when unfocused. Fire for
    // an input-needed flag (the actionable case).
    if (next === 'input' && !s.notifiedThisEpisode && this.isUnfocused()) {
      const t = this.now()
      if (t - s.lastNotifyAt >= NOTIFY_DEBOUNCE_MS) {
        s.notifiedThisEpisode = true
        s.lastNotifyAt = t
        this.notify(id, 'A session needs your input', s.lastNonEmptyLine.slice(0, 120))
      }
    }
  }

  /** Clear a flag and close the current episode (a new episode can notify again). */
  private clearFlag(s: SessionAtt, id: string): void {
    if (s.timer) { clearTimeout(s.timer); s.timer = null }
    s.notifiedThisEpisode = false
    if (s.state !== null) {
      s.state = null
      this.emit.onAttention(id, null)
    }
  }
}
