import type { Session, TicketFields } from '@shared/types'
import { validateTicketFields } from './validate'

// M-LOG-b (§4.4): the addendum pass — compress a deployed product chat's
// transcript into a schema-constrained roadmap ticket via a HEADLESS provider CLI.
//
// The CLI runner is INJECTED (HeadlessRunner) so this logic is fully testable
// without a real CLI, and so the actual `claude -p`/`codex exec` invocation — which
// touches the NN0 subscription-billing rule (FORBIDDEN_FLAGS currently bans -p) —
// can be wired separately once that policy question is resolved. Nothing here
// spawns a process or bills anything; it only builds prompts and validates output.

/** Runs a single headless CLI pass: takes a prompt, returns the CLI's raw stdout
 *  (expected to contain a JSON object for a ticket pass, or free text for a
 *  map-reduce notes pass). Implemented by main with runtime.host + guarded argv. */
export type HeadlessRunner = (prompt: string) => Promise<string>

/** Chunk large transcripts so each pass stays within a safe input budget (§4.4).
 *  We split at line boundaries accumulating up to `maxChars` per chunk — robust
 *  for ANSI-stripped PTY text where reliable turn markers aren't guaranteed. */
export function chunkTranscript(transcript: string, maxChars = 150_000): string[] {
  if (transcript.length <= maxChars) return [transcript]
  // Build segments (each guaranteed <= maxChars): a line keeps its trailing "\n",
  // and any segment still longer than the budget — a pathological single long
  // line — is hard-split so no segment can blow the CLI input budget.
  const segments: string[] = []
  const lines = transcript.split('\n')
  lines.forEach((line, i) => {
    const seg = i < lines.length - 1 ? line + '\n' : line // last line has no trailing \n
    if (seg.length <= maxChars) {
      if (seg) segments.push(seg)
    } else {
      for (let j = 0; j < seg.length; j += maxChars) segments.push(seg.slice(j, j + maxChars))
    }
  })
  // Pack segments into chunks up to maxChars.
  const chunks: string[] = []
  let cur = ''
  for (const seg of segments) {
    if (cur && cur.length + seg.length > maxChars) {
      chunks.push(cur)
      cur = ''
    }
    cur += seg
  }
  if (cur) chunks.push(cur)
  return chunks
}

const TICKET_SCHEMA_HINT = `Return ONLY a single JSON object (no prose, no code fence) with exactly these keys:
{"title": string, "subkind": "code"|"feature"|"bug", "problem": string, "solution": string,
 "files_touched": string[], "key_decisions": string[], "follow_ups": string[],
 "test_status": string, "deploy_ref": string}`

/** Prompt for the final ticket pass over a transcript (or over reduced notes). */
export function ticketPrompt(session: Session, material: string, fromNotes = false): string {
  const src = fromNotes ? 'per-chunk factual notes from a long work session' : 'transcript of a work session'
  return [
    `You are compressing the ${src} for the task "${session.objective}" (a ${session.taskSubkind} task) into a roadmap ticket.`,
    TICKET_SCHEMA_HINT,
    `Use "${session.taskSubkind}" as the subkind unless the work clearly differs.`,
    '',
    `----- BEGIN ${fromNotes ? 'NOTES' : 'TRANSCRIPT'} -----`,
    material,
    `----- END ${fromNotes ? 'NOTES' : 'TRANSCRIPT'} -----`
  ].join('\n')
}

/** Prompt for a per-chunk notes pass (map step). */
export function notesPrompt(session: Session, chunk: string, i: number, n: number): string {
  return [
    `This is part ${i + 1} of ${n} of a long work session for "${session.objective}".`,
    'Extract terse factual notes: what problem was worked, what changed, files touched, decisions, follow-ups, test/deploy status. Bullet points, no preamble.',
    '',
    '----- BEGIN PART -----',
    chunk,
    '----- END PART -----'
  ].join('\n')
}

/** Extract the FIRST complete top-level JSON object from CLI output (which may
 *  wrap it in prose or a code fence despite instructions). Brace-matches from the
 *  first `{`, respecting string literals and escapes, so a `}` inside a string —
 *  or trailing prose containing braces — doesn't break parsing. Returns the parsed
 *  value or throws. */
export function extractJson(output: string): unknown {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1] : output
  const start = candidate.indexOf('{')
  if (start < 0) throw new Error('no JSON object in CLI output')
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
    } else if (ch === '"') {
      inStr = true
    } else if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) return JSON.parse(candidate.slice(start, i + 1)) // first complete object
    }
  }
  throw new Error('no complete JSON object in CLI output')
}

/** Render the ticket Markdown body from the validated fields. */
export function renderTicketMd(f: TicketFields): string {
  const list = (items: string[]) => (items.length ? items.map((x) => `- ${x}`).join('\n') : '_none_')
  return [
    `# ${f.title}`,
    '',
    `**Type:** ${f.subkind}`,
    '',
    '## Problem',
    f.problem || '_n/a_',
    '',
    '## Solution',
    f.solution || '_n/a_',
    '',
    '## Files touched',
    list(f.files_touched),
    '',
    '## Key decisions',
    list(f.key_decisions),
    '',
    '## Follow-ups',
    list(f.follow_ups),
    '',
    `**Test status:** ${f.test_status || '_n/a_'}`,
    `**Deploy ref:** ${f.deploy_ref || '_n/a_'}`,
    ''
  ].join('\n')
}

/** Run the addendum pass: transcript → validated ticket. Chunks + map-reduces an
 *  oversized transcript (§4.4). Validates the CLI's JSON; on a schema failure,
 *  retries ONCE with the error appended to the prompt, then throws so the caller
 *  can surface a "ticket failed — retry" state (the session stays 'deployed'). */
export async function generateTicket(
  run: HeadlessRunner,
  session: Session,
  transcript: string,
  opts: { maxChars?: number } = {}
): Promise<{ fields: TicketFields; bodyMd: string }> {
  let material = transcript
  let fromNotes = false
  const chunks = chunkTranscript(transcript, opts.maxChars)
  if (chunks.length > 1) {
    // map: per-chunk factual notes; reduce: concatenate for the final pass.
    const notes: string[] = []
    for (let i = 0; i < chunks.length; i++) {
      notes.push(await run(notesPrompt(session, chunks[i], i, chunks.length)))
    }
    material = notes.join('\n\n')
    fromNotes = true
  }

  const basePrompt = ticketPrompt(session, material, fromNotes)
  let lastErr = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt =
      attempt === 0
        ? basePrompt
        : `${basePrompt}\n\nYour previous reply was invalid: ${lastErr}\nReturn ONLY the corrected JSON object.`
    try {
      const fields = validateTicketFields(extractJson(await run(prompt)))
      return { fields, bodyMd: renderTicketMd(fields) }
    } catch (err) {
      lastErr = (err as Error).message
    }
  }
  throw new Error(`ticket generation failed: ${lastErr}`)
}
