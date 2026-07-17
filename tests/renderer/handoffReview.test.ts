// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { HandoffReview } from '../../src/renderer/components/HandoffReview'

describe('HandoffReview', () => {
  it('returns null when nothing is pending', () => {
    expect(HandoffReview({ count: 0, totalChars: 0, inFix: false, onInsert: () => {} })).toBeNull()
  })

  it('renders a "Review & insert" affordance with the pending count', () => {
    const el = HandoffReview({ count: 2, totalChars: 1234, inFix: false, onInsert: () => {} })!
    expect(el.querySelector('.hr-insert')!.textContent).toMatch(/Review & insert/i)
    expect(el.querySelector('.hr-label')!.textContent).toContain('2 sections')
    expect(el.querySelector('.hr-warn')).toBeNull() // no fix warning when not in fix
  })

  it('shows a FIX-mode warning banner BEFORE the insert control when inFix', () => {
    const el = HandoffReview({ count: 1, totalChars: 10, inFix: true, onInsert: () => {} })!
    const warn = el.querySelector('.hr-warn')
    expect(warn).toBeTruthy()
    expect(warn!.textContent).toMatch(/FIX mode/i)
    // banner precedes the row (it's the first child)
    expect(el.firstElementChild).toBe(warn)
  })

  it('fires onInsert when the button is clicked', () => {
    const onInsert = vi.fn()
    const el = HandoffReview({ count: 1, totalChars: 10, inFix: false, onInsert })!
    ;(el.querySelector('.hr-insert') as HTMLButtonElement).click()
    expect(onInsert).toHaveBeenCalled()
  })
})
