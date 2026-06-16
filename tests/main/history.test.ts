import { describe, it, expect } from 'vitest'
import { stripAnsi, buildPrimer, historyFile } from '../../src/main/history'

describe('stripAnsi', () => {
  it('removes SGR color codes', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m text')).toBe('red text')
  })
  it('removes cursor-move / erase CSI sequences', () => {
    expect(stripAnsi('a\x1b[2Kb\x1b[1;1Hc')).toBe('abc')
  })
  it('removes OSC sequences (titles, hyperlinks) with BEL or ST terminators', () => {
    expect(stripAnsi('\x1b]0;window title\x07hello')).toBe('hello')
    expect(stripAnsi('\x1b]8;;https://x.com\x1b\\link\x1b]8;;\x1b\\')).toBe('link')
  })
  it('collapses carriage-return rewrites to the final state', () => {
    expect(stripAnsi('loading...\rdone     ')).toBe('done     ')
  })
  it('drops stray control bytes but keeps tabs and newlines', () => {
    expect(stripAnsi('a\x00b\tc\nd')).toBe('ab\tc\nd')
  })
  it('squeezes excessive blank lines from TUI redraws', () => {
    expect(stripAnsi('a\n\n\n\n\nb')).toBe('a\n\nb')
  })
})

describe('buildPrimer', () => {
  it('returns empty for empty/whitespace history', () => {
    expect(buildPrimer('')).toBe('')
    expect(buildPrimer('\x1b[0m   \n  ')).toBe('')
  })
  it('wraps cleaned history in a restore primer', () => {
    const p = buildPrimer('\x1b[32muser: hi\x1b[0m\nassistant: hello')
    expect(p).toContain('Session restored by the IDE')
    expect(p).toContain('user: hi')
    expect(p).toContain('assistant: hello')
    expect(p).toContain('BEGIN PRIOR HISTORY')
    expect(p).not.toContain('\x1b') // no escape codes leak into the primer
  })
  it('tail-caps long history to the most recent maxChars', () => {
    const long = 'x'.repeat(50000) + 'TAILMARKER'
    const p = buildPrimer(long, 1000)
    expect(p).toContain('TAILMARKER')
    expect(p.length).toBeLessThan(1500)
  })
})

describe('historyFile', () => {
  it('builds a per-session path under the history dir', () => {
    expect(historyFile('sess-3-123')).toMatch(/\/AgentIDE\/history\/sess-3-123\.log$/)
  })
  it('sanitizes unsafe characters (no path traversal)', () => {
    expect(historyFile('../../etc/passwd')).toMatch(/\/history\/_.*passwd\.log$/)
    expect(historyFile('../../etc/passwd')).not.toContain('..')
  })
})
