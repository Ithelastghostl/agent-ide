// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { SearchOverlay } from '../../src/renderer/components/SearchOverlay'
import type { SearchHit } from '@shared/types'

const transcriptHit: SearchHit = {
  type: 'transcript',
  sessionId: 's-1',
  projectId: 'p-1',
  snippet: 'found [needle] here',
  ts: 123
}
const backlogHit: SearchHit = {
  type: 'backlog',
  itemId: 'bl-1',
  projectId: 'p-1',
  title: 'Needle epic',
  snippet: 'a [needle] task',
  status: 'planned',
  kind: 'task'
}

const DEBOUNCE = 20 // small real debounce so tests stay fast but exercise the timer

interface Harness {
  el: HTMLElement
  searchQuery: ReturnType<typeof vi.fn>
  onSelectTranscript: ReturnType<typeof vi.fn>
  onSelectBacklog: ReturnType<typeof vi.fn>
  onClose: ReturnType<typeof vi.fn>
  input: HTMLInputElement
}

function mount(hits: SearchHit[]): Harness {
  const searchQuery = vi.fn().mockResolvedValue(hits)
  const onSelectTranscript = vi.fn()
  const onSelectBacklog = vi.fn()
  const onClose = vi.fn()
  const el = SearchOverlay({
    searchQuery,
    onSelectTranscript,
    onSelectBacklog,
    onClose,
    debounceMs: DEBOUNCE
  })
  document.body.appendChild(el)
  const input = el.querySelector('.search-input') as HTMLInputElement
  return { el, searchQuery, onSelectTranscript, onSelectBacklog, onClose, input }
}

function type(input: HTMLInputElement, value: string) {
  input.value = value
  input.dispatchEvent(new Event('input'))
}

function key(input: HTMLInputElement, k: string) {
  input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Wait past the debounce window and let the (resolved) searchQuery render. */
async function fire() {
  await delay(DEBOUNCE + 15)
}

describe('SearchOverlay', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('debounces the query: one call after the window, not per keystroke', async () => {
    const h = mount([transcriptHit])
    type(h.input, 'n')
    type(h.input, 'ne')
    type(h.input, 'nee')
    // still inside the debounce window — no call yet
    expect(h.searchQuery).not.toHaveBeenCalled()
    await fire()
    expect(h.searchQuery).toHaveBeenCalledTimes(1)
    expect(h.searchQuery).toHaveBeenCalledWith('nee', 50)
  })

  it('does not query for an empty/whitespace term', async () => {
    const h = mount([])
    type(h.input, '   ')
    await fire()
    expect(h.searchQuery).not.toHaveBeenCalled()
  })

  it('renders grouped union results: Transcripts and Backlog sections', async () => {
    const h = mount([transcriptHit, backlogHit])
    type(h.input, 'needle')
    await fire()
    const groups = [...h.el.querySelectorAll('.search-group')].map((g) => g.textContent)
    expect(groups).toEqual(['Transcripts', 'Backlog'])
    expect(h.el.querySelectorAll('.search-row.transcript').length).toBe(1)
    expect(h.el.querySelectorAll('.search-row.backlog').length).toBe(1)
    // union fields render via textContent
    expect(h.el.querySelector('.search-row.transcript')!.textContent).toContain('found [needle] here')
    expect(h.el.querySelector('.search-row.backlog .sr-name')!.textContent).toBe('Needle epic')
    expect(h.el.querySelector('.search-row.backlog .sr-status')!.textContent).toBe('planned')
  })

  it('renders hit text via textContent (no HTML injection)', async () => {
    const evil: SearchHit = {
      type: 'backlog',
      itemId: 'x',
      projectId: 'p',
      title: '<img src=x onerror=alert(1)>',
      snippet: 's',
      status: 'planned',
      kind: 'task'
    }
    const h = mount([evil])
    type(h.input, 'x')
    await fire()
    const name = h.el.querySelector('.search-row.backlog .sr-name')!
    expect(name.querySelector('img')).toBeNull()
    expect(name.textContent).toBe('<img src=x onerror=alert(1)>')
  })

  it('shows an empty state when a non-empty query returns nothing', async () => {
    const h = mount([])
    type(h.input, 'zzz')
    await fire()
    expect(h.el.querySelector('.search-empty')!.textContent).toBe('No matches.')
  })

  it('keyboard nav: ↓ moves selection, wraps, and highlights one row', async () => {
    const h = mount([transcriptHit, backlogHit])
    type(h.input, 'needle')
    await fire()
    const rows = () => [...h.el.querySelectorAll('.search-row')]
    // first row active by default
    expect(rows()[0].classList.contains('on')).toBe(true)
    key(h.input, 'ArrowDown')
    expect(rows()[0].classList.contains('on')).toBe(false)
    expect(rows()[1].classList.contains('on')).toBe(true)
    // wrap back to top
    key(h.input, 'ArrowDown')
    expect(rows()[0].classList.contains('on')).toBe(true)
    // exactly one highlighted
    expect(h.el.querySelectorAll('.search-row.on').length).toBe(1)
  })

  it('Enter on a transcript hit fires onSelectTranscript with project+session and closes', async () => {
    const h = mount([transcriptHit, backlogHit])
    type(h.input, 'needle')
    await fire()
    key(h.input, 'Enter') // first row = transcript
    expect(h.onSelectTranscript).toHaveBeenCalledWith('p-1', 's-1')
    expect(h.onSelectBacklog).not.toHaveBeenCalled()
    expect(h.onClose).toHaveBeenCalledTimes(1)
  })

  it('Enter on a backlog hit fires onSelectBacklog with project+item', async () => {
    const h = mount([transcriptHit, backlogHit])
    type(h.input, 'needle')
    await fire()
    key(h.input, 'ArrowDown') // move to the backlog row
    key(h.input, 'Enter')
    expect(h.onSelectBacklog).toHaveBeenCalledWith('p-1', 'bl-1')
    expect(h.onSelectTranscript).not.toHaveBeenCalled()
    expect(h.onClose).toHaveBeenCalledTimes(1)
  })

  it('Escape closes the overlay', () => {
    const h = mount([])
    key(h.input, 'Escape')
    expect(h.onClose).toHaveBeenCalledTimes(1)
  })

  it('ignores a stale response after a newer query (out-of-order guard)', async () => {
    // First query resolves slowly with A; second resolves fast with B. Only B renders.
    const slow: SearchHit[] = [{ ...transcriptHit, sessionId: 'STALE' }]
    const fresh: SearchHit[] = [backlogHit]
    let resolveSlow!: (v: SearchHit[]) => void
    const searchQuery = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<SearchHit[]>((r) => {
            resolveSlow = r
          })
      )
      .mockResolvedValueOnce(fresh)
    const el = SearchOverlay({
      searchQuery,
      onSelectTranscript: vi.fn(),
      onSelectBacklog: vi.fn(),
      onClose: vi.fn(),
      debounceMs: DEBOUNCE
    })
    document.body.appendChild(el)
    const input = el.querySelector('.search-input') as HTMLInputElement
    type(input, 'a')
    await fire() // fires slow query (token 1, pending)
    type(input, 'ab')
    await fire() // fires fresh query (token 2) → renders B
    resolveSlow(slow) // late slow resolve (token 1)
    await delay(5) // flush the late microtask
    // B (backlog) shown, STALE transcript never rendered
    expect(el.querySelector('.search-row.backlog')).toBeTruthy()
    expect(el.textContent).not.toContain('STALE')
  })
})
