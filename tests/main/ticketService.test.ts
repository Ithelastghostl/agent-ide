import { describe, it, expect } from 'vitest'
import {
  generateTicket, chunkTranscript, extractJson, renderTicketMd, ticketPrompt
} from '../../src/main/ticketService'
import type { Session, TicketFields } from '@shared/types'

const session: Session = {
  id: 's1', projectId: 'p1', provider: 'claude', model: 'claude-opus-4-8',
  objective: 'fix the widget race', status: 'running', createdAt: 1, updatedAt: 2,
  taskKind: 'product', taskSubkind: 'bug', taskStatus: 'deployed'
}

const validTicketJson = JSON.stringify({
  title: 'Fix widget race', subkind: 'bug', problem: 'raced on shutdown', solution: 'added a lock',
  files_touched: ['widget.ts'], key_decisions: ['use a mutex'], follow_ups: ['add a stress test'],
  test_status: 'unit green', deploy_ref: 'abc123'
})

describe('chunkTranscript (§4.4 map-reduce)', () => {
  it('returns one chunk when under the budget', () => {
    expect(chunkTranscript('short', 100)).toEqual(['short'])
  })
  it('splits a large transcript at line boundaries into multiple chunks', () => {
    const big = Array.from({ length: 50 }, (_, i) => `line-${i} ${'x'.repeat(40)}`).join('\n')
    const chunks = chunkTranscript(big, 200)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('').replace(/\n/g, '')).toBe(big.replace(/\n/g, '')) // no content lost
  })
})

describe('extractJson', () => {
  it('parses a bare JSON object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
  })
  it('parses JSON wrapped in prose or a code fence', () => {
    expect(extractJson('Here you go:\n```json\n{"a":2}\n```\ndone')).toEqual({ a: 2 })
    expect(extractJson('sure! {"a":3} hope that helps')).toEqual({ a: 3 })
  })
  it('throws when there is no JSON object', () => {
    expect(() => extractJson('no json here')).toThrow()
  })
})

describe('renderTicketMd', () => {
  it('renders the fields into Markdown with all sections', () => {
    const f: TicketFields = JSON.parse(validTicketJson)
    const md = renderTicketMd(f)
    expect(md).toContain('# Fix widget race')
    expect(md).toContain('**Type:** bug')
    expect(md).toContain('- widget.ts')
    expect(md).toContain('**Deploy ref:** abc123')
  })
  it('shows _none_ for empty lists', () => {
    const f: TicketFields = { ...JSON.parse(validTicketJson), follow_ups: [] }
    expect(renderTicketMd(f)).toContain('## Follow-ups\n_none_')
  })
})

describe('generateTicket (§4.4)', () => {
  it('produces a validated ticket from a single pass', async () => {
    const calls: string[] = []
    const run = async (p: string) => { calls.push(p); return validTicketJson }
    const { fields, bodyMd } = await generateTicket(run, session, 'short transcript')
    expect(fields.title).toBe('Fix widget race')
    expect(bodyMd).toContain('# Fix widget race')
    expect(calls).toHaveLength(1) // no chunking for a short transcript
  })

  it('map-reduces an oversized transcript (chunk notes → final ticket)', async () => {
    // multi-line so chunkTranscript can split at line boundaries
    const big = Array.from({ length: 40 }, (_, i) => `line ${i} ${'x'.repeat(30)}`).join('\n')
    let ticketCall = ''
    const run = async (p: string) => {
      if (p.includes('BEGIN NOTES')) { ticketCall = p; return validTicketJson } // final pass
      return `notes for a chunk` // map pass
    }
    const { fields } = await generateTicket(run, session, big, { maxChars: 100 })
    expect(fields.title).toBe('Fix widget race')
    expect(ticketCall).toContain('per-chunk factual notes') // the final pass ran over notes
  })

  it('retries ONCE with the error when the first reply is invalid, then succeeds', async () => {
    let n = 0
    const run = async () => (n++ === 0 ? '{"title": 123 bad}' : validTicketJson)
    const { fields } = await generateTicket(run, session, 'short')
    expect(fields.title).toBe('Fix widget race')
    expect(n).toBe(2) // one bad + one good
  })

  it('throws ticket-failed after the retry also fails', async () => {
    const run = async () => 'not even json'
    await expect(generateTicket(run, session, 'short')).rejects.toThrow(/ticket generation failed/i)
  })
})

describe('ticketPrompt', () => {
  it('embeds the schema hint and the transcript', () => {
    const p = ticketPrompt(session, 'the transcript body', false)
    expect(p).toContain('files_touched')
    expect(p).toContain('the transcript body')
    expect(p).toContain('bug') // subkind hint
  })
})
