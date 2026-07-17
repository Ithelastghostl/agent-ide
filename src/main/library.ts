import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync, readdirSync, readFileSync, existsSync, statSync, writeFileSync } from 'node:fs'
import type { LibraryItem, LibraryContents, LibraryCategory, AgentInput } from '@shared/types'
import { confinedPath } from './confine'

/** Root of the GitHub-backed library folder (a clone of the user's library repo:
 *  skills/, prompts/, workflows/ of plain files the agent CLIs read natively).
 *  AGENT_IDE_LIBRARY overrides it for tests. Mirrors history.ts's historyDir(). */
export function libraryDir(): string {
  const dir = process.env.AGENT_IDE_LIBRARY || join(homedir(), 'AgentIDE', 'library')
  mkdirSync(dir, { recursive: true })
  return dir
}

// Library-relative reads are confined via the shared, symlink-hardened
// confinedPath (B1/B2/L1) — a symlink inside the library repo can't escape it.

/** Parse a leading YAML-frontmatter block (--- … ---) into a flat string map plus
 *  the remaining body. Supports `key: value` and `key: |` multiline blocks — the
 *  subset SKILL.md / command frontmatter actually uses. NOT a full YAML parser
 *  (no nested maps/lists), deliberately dependency-free. Missing/!-fenced input
 *  returns empty meta and the original text as body. */
export function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) return { meta: {}, body: text }
  const [, block, body] = m
  const meta: Record<string, string> = {}
  const lines = block.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!kv) continue
    const key = kv[1]
    let val = kv[2]
    if (val === '|' || val === '>' || val === '|-' || val === '>-') {
      // Multiline block scalar: gather following more-indented lines.
      const collected: string[] = []
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
        collected.push(lines[++i].replace(/^\s+/, ''))
      }
      val = collected.join(' ').trim()
    } else {
      val = decodeScalar(val.trim())
    }
    meta[key] = val
  }
  return { meta, body: body ?? '' }
}

/** Decode a frontmatter scalar. A fully double-quoted value is a YAML/JSON
 *  double-quoted string — JSON.parse it so escapes round-trip (the agent writer
 *  emits these). Anything else keeps the legacy behavior (strip surrounding
 *  quote chars) so existing library files parse unchanged. */
function decodeScalar(val: string): string {
  if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) {
    try {
      return JSON.parse(val)
    } catch {
      /* not valid JSON — legacy strip */
    }
  }
  return val.replace(/^["']|["']$/g, '')
}

/** Best-effort name/description extraction from a workflow .js file's
 *  `export const meta = { name: '…', description: '…', … }`. Bounded regexes so a
 *  large script body isn't fully parsed; returns {} if not found. */
export function parseWorkflowMeta(text: string): { name?: string; description?: string } {
  const head = text.slice(0, 4000)
  const name = /\bname\s*:\s*['"`]([^'"`]+)['"`]/.exec(head)?.[1]
  const description = /\bdescription\s*:\s*['"`]([^'"`]+)['"`]/.exec(head)?.[1]
  return { name, description }
}

function firstHeading(body: string): string | undefined {
  const h = /^#\s+(.+)$/m.exec(body)
  return h?.[1]?.trim()
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** Scan one category folder into LibraryItems.
 *  - skills:    subdirectories containing a SKILL.md (name/description from frontmatter)
 *  - prompts:   *.md files (frontmatter description, else first heading, else filename)
 *  - agents:    *.md files (like prompts; body carries the layered sections)
 *  - workflows: *.js files (name/description from `export const meta`) */
function scanCategory(libRoot: string, category: LibraryCategory): LibraryItem[] {
  const dir = join(libRoot, category)
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const items: LibraryItem[] = []

  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    if (category === 'skills') {
      if (!e.isDirectory()) continue
      const skillFile = join(dir, e.name, 'SKILL.md')
      if (!existsSync(skillFile)) continue
      const { meta, body } = parseFrontmatter(readText(skillFile))
      items.push({
        category,
        name: meta.name || e.name,
        description: meta.description || firstHeading(body) || '',
        relPath: `${category}/${e.name}/SKILL.md`,
        path: skillFile
      })
    } else if (category === 'prompts' || category === 'agents') {
      if (!e.isFile() || !e.name.endsWith('.md')) continue
      const file = join(dir, e.name)
      const { meta, body } = parseFrontmatter(readText(file))
      const base = e.name.replace(/\.md$/, '')
      items.push({
        category,
        name: meta.name || base,
        description: meta.description || firstHeading(body) || '',
        relPath: `${category}/${e.name}`,
        path: file
      })
    } else {
      // workflows
      if (!e.isFile() || !e.name.endsWith('.js')) continue
      const file = join(dir, e.name)
      const { name, description } = parseWorkflowMeta(readText(file))
      items.push({
        category,
        name: name || e.name.replace(/\.js$/, ''),
        description: description || '',
        relPath: `${category}/${e.name}`,
        path: file
      })
    }
  }
  items.sort((a, b) => a.name.localeCompare(b.name))
  return items
}

/** Scan a library folder into its categories. Pure over the passed root
 *  (tests call it with a temp dir). Missing categories yield empty arrays. */
export function scanLibrary(libRoot: string): LibraryContents {
  return {
    prompts: scanCategory(libRoot, 'prompts'),
    skills: scanCategory(libRoot, 'skills'),
    workflows: scanCategory(libRoot, 'workflows'),
    agents: scanCategory(libRoot, 'agents')
  }
}

/** Read a library item's full text, confined to the library root. Returns
 *  { content } or { error }. Caps at 1 MB (library items are text). */
export function readLibraryItem(relPath: string): { content?: string; error?: string } {
  const abs = confinedPath(libraryDir(), relPath)
  if (!abs) return { error: 'path outside library' }
  try {
    if (statSync(abs).size > 1024 * 1024) return { error: 'item too large' }
    return { content: readFileSync(abs, 'utf8') }
  } catch (err) {
    return { error: (err as Error).message }
  }
}

/** True if the library folder is a git clone (has a .git dir) — so sync can pick
 *  `git pull` vs an initial clone. */
export function libraryIsClone(libRoot: string = libraryDir()): boolean {
  return existsSync(join(libRoot, '.git'))
}

// ---- Agents (multi-layer agent files) --------------------------------------
// One agent = agents/<slug>.md: YAML frontmatter (name, description) + layered
// body sections (# Instructions / # Data / # Context). The library is
// local-first: adding works whether or not the folder is a git clone.

const AGENT_NAME_MAX = 80
const AGENT_DESC_MAX = 200
const AGENT_LAYER_MAX = 64 * 1024
const AGENT_FILE_MAX = 256 * 1024

/** Derive the filesystem slug for an agent name: lowercase, runs of anything
 *  outside [a-z0-9] collapse to '-', trimmed. Empty result = invalid name. */
export function agentSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '')
}

/** Validate an addAgent payload at the IPC boundary. Returns a typed AgentInput
 *  or throws with a user-facing message. */
export function validateAgentInput(raw: unknown): AgentInput {
  const o = (raw ?? {}) as Record<string, unknown>
  const str = (k: string): string => (typeof o[k] === 'string' ? (o[k] as string) : '')
  const name = str('name').trim()
  const description = str('description').trim()
  if (!name || name.length > AGENT_NAME_MAX)
    throw new Error(`agent name must be 1–${AGENT_NAME_MAX} characters`)
  if (!agentSlug(name)) throw new Error('agent name must contain at least one letter or digit')
  if (/[\r\n]/.test(description)) throw new Error('description must be a single line')
  if (description.length > AGENT_DESC_MAX)
    throw new Error(`description must be ≤${AGENT_DESC_MAX} characters`)
  const layers = { instructions: str('instructions'), data: str('data'), context: str('context') }
  for (const [k, v] of Object.entries(layers)) {
    if (v.length > AGENT_LAYER_MAX) throw new Error(`${k} layer exceeds ${AGENT_LAYER_MAX / 1024}KB`)
  }
  return { name, description, ...layers }
}

/** Render the agent markdown. Frontmatter scalars are JSON-quoted (valid YAML
 *  double-quoted strings) so quotes/colons/# round-trip; parseFrontmatter
 *  JSON-decodes them. */
export function renderAgentMd(a: AgentInput): string {
  const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim()
  return [
    '---',
    `name: ${JSON.stringify(oneLine(a.name))}`,
    `description: ${JSON.stringify(oneLine(a.description))}`,
    '---',
    '',
    '# Instructions',
    a.instructions.trim(),
    '',
    '# Data',
    a.data.trim(),
    '',
    '# Context',
    a.context.trim(),
    ''
  ].join('\n')
}

/** Create agents/<slug>.md in the library. Exclusive write ('wx') — an existing
 *  slug is an error, never an overwrite. Returns { relPath } or { error }. */
export function addAgent(raw: unknown, libRoot: string = libraryDir()): { relPath?: string; error?: string } {
  let input: AgentInput
  try {
    input = validateAgentInput(raw)
  } catch (err) {
    return { error: (err as Error).message }
  }
  const body = renderAgentMd(input)
  if (body.length > AGENT_FILE_MAX) return { error: `agent file exceeds ${AGENT_FILE_MAX / 1024}KB` }
  const relPath = `agents/${agentSlug(input.name)}.md`
  mkdirSync(join(libRoot, 'agents'), { recursive: true })
  const abs = confinedPath(libRoot, relPath)
  if (!abs) return { error: 'path outside library' }
  try {
    writeFileSync(abs, body, { encoding: 'utf8', flag: 'wx' })
    return { relPath }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return {
      error:
        code === 'EEXIST'
          ? `an agent named "${agentSlug(input.name)}" already exists`
          : (err as Error).message
    }
  }
}
