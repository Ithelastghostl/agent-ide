import { describe, it, expect } from 'vitest'
import {
  composePrimer,
  stripReviewSpans,
  reviewOpen,
  reviewClose,
  historyFullyAccountsFor
} from '../../src/main/launchPrimer'

describe('composePrimer trusted/review split (R2-6)', () => {
  it('trusted sections auto-submit; review sections go to reviewText', () => {
    const { submitText, reviewText } = composePrimer([
      { kind: 'harness', trust: 'trusted', label: 'protocol', body: 'the protocol' },
      { kind: 'objective', trust: 'trusted', label: 'obj', body: 'do the thing' },
      { kind: 'linear', trust: 'review', label: 'LIN-1', body: 'untrusted remote text' }
    ])
    expect(submitText).toContain('BEGIN HARNESS')
    expect(submitText).toContain('the protocol')
    expect(submitText).toContain('do the thing')
    expect(submitText).not.toContain('untrusted remote text')
    expect(reviewText).toContain('untrusted remote text')
    expect(reviewText).toContain('BEGIN LINEAR')
  })

  it('caps section bodies', () => {
    const big = 'x'.repeat(50_000)
    const { submitText } = composePrimer([{ kind: 'agent', trust: 'trusted', label: 'a', body: big }])
    // agent cap is 32k plus fence overhead
    expect(submitText.length).toBeLessThan(33_000)
  })
})

describe('review sentinel stripping (R19/R20)', () => {
  it('strips complete review spans from history', () => {
    const id = 'abc'
    const hist = `before ${reviewOpen(id)}SECRET REVIEW${reviewClose(id)} after`
    expect(stripReviewSpans(hist)).toBe('before  after')
  })
  it('fail-closed: drops everything after a dangling open sentinel', () => {
    const hist = `keep this ${reviewOpen('x')}truncated review body with no close`
    expect(stripReviewSpans(hist)).toBe('keep this ')
  })
  it('history is demoted to review when a logged payload is not accounted for', () => {
    // history that still literally contains the review payload → not accounted for
    const { submitText, reviewText } = composePrimer(
      [
        { kind: 'history', trust: 'trusted', label: 'h', body: 'user pasted PROPRIETARY_TOKEN into the chat' }
      ],
      ['PROPRIETARY_TOKEN']
    )
    expect(submitText).not.toContain('PROPRIETARY_TOKEN')
    expect(reviewText).toContain('PROPRIETARY_TOKEN')
  })
  it('history auto-submits when no logged payload leaks', () => {
    const { submitText } = composePrimer(
      [{ kind: 'history', trust: 'trusted', label: 'h', body: 'clean conversation history' }],
      ['some-review-that-is-absent']
    )
    expect(submitText).toContain('clean conversation history')
  })
})

describe('historyFullyAccountsFor', () => {
  it('true when no payload appears in stripped history', () => {
    expect(historyFullyAccountsFor('clean text', ['secret'])).toBe(true)
  })
  it('false when a payload still appears', () => {
    expect(historyFullyAccountsFor('has secret in it', ['secret'])).toBe(false)
  })
})
