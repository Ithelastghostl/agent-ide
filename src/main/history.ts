import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'

/** Root of the committable per-session history folder (mirrors SQLite transcripts
 *  in a human-readable, git-friendly form). One file per session. */
export function historyDir(): string {
  // AGENT_IDE_HISTORY lets tests point at a throwaway dir instead of the user's
  // real history. Unset in normal use.
  const dir = process.env.AGENT_IDE_HISTORY || join(homedir(), 'AgentIDE', 'history')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Path to a session's history file. Session ids are filesystem-safe (sess-N-PID
 *  / term-… / login-…), but sanitize defensively against path traversal. */
export function historyFile(sessionId: string): string {
  const safe = sessionId
    .replace(/[^a-zA-Z0-9._-]/g, '_') // drop separators / unsafe chars
    .replace(/\.\.+/g, '_')           // collapse any '..' so no traversal token survives
  return join(historyDir(), `${safe}.log`)
}

/** Strip ANSI/VT control sequences and other terminal noise from raw pty output,
 *  leaving readable plain text. Covers CSI (colors, cursor moves, erases), OSC
 *  (titles, hyperlinks), charset selects, single-char escapes, carriage-return
 *  line rewrites, and stray C0 control bytes. Not a perfect de-render, but good
 *  enough to seed an engine with conversation context. */
export function stripAnsi(raw: string): string {
  let s = raw
  // OSC sequences: ESC ] ... terminated by BEL (\x07) or ST (ESC \).
  s = s.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
  // CSI sequences: ESC [ ... final byte @-~ (SGR colors, cursor moves, erase, …).
  s = s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
  // Two-byte charset-select escapes: ESC ( B, ESC ) 0, etc.
  s = s.replace(/\x1b[()][0-9A-Za-z]/g, '')
  // Other single-byte escapes: ESC =, ESC >, ESC 7/8, ESC M/D/E/H/c, …
  s = s.replace(/\x1b[=>78MDEHc]/g, '')
  // Collapse carriage-return rewrites: the text after the final \r on a line wins.
  s = s
    .split('\n')
    .map((line) => {
      const parts = line.split('\r')
      return parts[parts.length - 1]
    })
    .join('\n')
  // Drop remaining C0 control chars except tab (\x09) and newline (\x0a), plus DEL.
  s = s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
  // Squeeze runs of blank lines (TUI redraws leave many).
  s = s.replace(/\n{3,}/g, '\n\n')
  return s
}

/** Build a primer message that seeds a fresh engine with a session's prior
 *  conversation, so reconnecting OR switching the model continues with context.
 *  The history is cleaned terminal text (best-effort), tail-capped so the primer
 *  isn't enormous. Returns '' when there's nothing worth replaying. */
export function buildPrimer(rawTranscript: string, maxChars = 16000): string {
  const cleaned = stripAnsi(rawTranscript).trim()
  if (!cleaned) return ''
  const body = cleaned.length > maxChars ? cleaned.slice(cleaned.length - maxChars) : cleaned
  return [
    '[Session restored by the IDE. This is the prior conversation/terminal history',
    'for this session (it may be from a different model). Use it as context and',
    'continue from where it left off. Do not repeat work already done.]',
    '',
    '----- BEGIN PRIOR HISTORY -----',
    body,
    '----- END PRIOR HISTORY -----',
    ''
  ].join('\n')
}
