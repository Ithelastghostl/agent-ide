import { join, resolve, relative, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync, readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import type { LibraryItem, LibraryContents, LibraryCategory } from '@shared/types'

/** Root of the GitHub-backed library folder (a clone of the user's library repo:
 *  skills/, prompts/, workflows/ of plain files the agent CLIs read natively).
 *  AGENT_IDE_LIBRARY overrides it for tests. Mirrors history.ts's historyDir(). */
export function libraryDir(): string {
  const dir = process.env.AGENT_IDE_LIBRARY || join(homedir(), 'AgentIDE', 'library')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Resolve a library-relative path and confirm it stays inside `root` (no `..`/
 *  symlink escape). Returns the absolute path, or null if it would escape. Same
 *  guard shape as ipc.ts's confinedPath — kept local to avoid coupling to ipc. */
function confined(root: string, rel: string): string | null {
  const r = resolve(root)
  const t = resolve(root, rel)
  const out = relative(r, t)
  if (out.startsWith('..') || isAbsolute(out)) return null
  return t
}

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
      val = val.trim().replace(/^["']|["']$/g, '') // strip surrounding quotes
    }
    meta[key] = val
  }
  return { meta, body: body ?? '' }
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
  try { return readFileSync(path, 'utf8') } catch { return '' }
}

/** Scan one category folder into LibraryItems.
 *  - skills:    subdirectories containing a SKILL.md (name/description from frontmatter)
 *  - prompts:   *.md files (frontmatter description, else first heading, else filename)
 *  - workflows: *.js files (name/description from `export const meta`) */
function scanCategory(libRoot: string, category: LibraryCategory): LibraryItem[] {
  const dir = join(libRoot, category)
  let entries: import('node:fs').Dirent[]
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return [] }
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
    } else if (category === 'prompts') {
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

/** Scan a library folder into its three categories. Pure over the passed root
 *  (tests call it with a temp dir). Missing categories yield empty arrays. */
export function scanLibrary(libRoot: string): LibraryContents {
  return {
    prompts: scanCategory(libRoot, 'prompts'),
    skills: scanCategory(libRoot, 'skills'),
    workflows: scanCategory(libRoot, 'workflows')
  }
}

/** Read a library item's full text, confined to the library root. Returns
 *  { content } or { error }. Caps at 1 MB (library items are text). */
export function readLibraryItem(relPath: string): { content?: string; error?: string } {
  const abs = confined(libraryDir(), relPath)
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
