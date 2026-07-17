import { readHarness } from './harness'
import { readLibraryItem, scanLibrary, libraryDir } from './library'
import { composePrimer, type PrimerSection } from './launchPrimer'

// S8 (agent presets): when a session is launched from a library agent, its body
// is primed into the session AFTER the harness section (P0.D primer contract).
// The agent file is a local, user-owned library row, so its section is TRUSTED
// and auto-submitted alongside the harness + objective — matching the primer the
// canonical launcher assembles for every provider session.

/** Strip a leading YAML frontmatter block from an agent markdown body — the
 *  frontmatter is metadata (name/description), not instructions to prime. Mirrors
 *  the renderer's library-insertion behavior so the primed agent body matches
 *  what a manual "Use agent" insertion would deliver. */
export function stripAgentFrontmatter(text: string): string {
  const m = /^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  return (m ? m[1] : text).trim()
}

/** True iff `relPath` is a registered library agent — confined read + membership
 *  in the agents registry (R7). Used by validateLaunchRequest's isKnownAgent. */
export function isRegisteredAgent(relPath: string, libRoot: string = libraryDir()): boolean {
  return scanLibrary(libRoot).agents.some((a) => a.relPath === relPath)
}

/** Read a registered agent's primeable body (frontmatter stripped). Returns '' if
 *  the file can't be read or isn't a registered agent (fail-safe: no primer). */
export function agentBodyForPrimer(relPath: string | null | undefined): string {
  if (!relPath || !isRegisteredAgent(relPath)) return ''
  const { content } = readLibraryItem(relPath)
  return content ? stripAgentFrontmatter(content) : ''
}

/** Compose the fresh-launch primer for a provider session: harness → agent (if
 *  any) → objective, all trusted and auto-submitted. The agent section lands
 *  AFTER the harness section per the P0.D contract. Returns the auto-submit text
 *  (no trailing newline). */
export function composeLaunchPrimer(opts: {
  objective: string
  stage?: string
  agentRelPath?: string | null
  agentLabel?: string
}): string {
  const sections: PrimerSection[] = [
    { kind: 'harness', trust: 'trusted', label: 'protocol', body: readHarness() }
  ]
  const agentBody = agentBodyForPrimer(opts.agentRelPath)
  if (agentBody) {
    sections.push({ kind: 'agent', trust: 'trusted', label: opts.agentLabel || 'preset', body: agentBody })
  }
  sections.push({
    kind: 'objective',
    trust: 'trusted',
    label: opts.objective || 'session',
    body: `Stage: ${opts.stage ?? 'discussion'}\nObjective: ${opts.objective || '(none)'}`
  })
  return composePrimer(sections).submitText
}
