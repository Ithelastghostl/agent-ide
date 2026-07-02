import { describe, it, expect } from 'vitest'
import { isSafeExternalUrl } from '../../src/main/ipc'

describe('isSafeExternalUrl — guards what reaches the OS browser', () => {
  it('allows http and https', () => {
    expect(isSafeExternalUrl('https://github.com/login/device')).toBe(true)
    expect(isSafeExternalUrl('http://localhost:1455/callback?code=abc')).toBe(true)
  })

  it('allows mailto', () => {
    expect(isSafeExternalUrl('mailto:someone@example.com')).toBe(true)
  })

  it('rejects file: and custom/dangerous schemes from untrusted terminal output', () => {
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false)
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeExternalUrl('vscode://foo')).toBe(false)
    expect(isSafeExternalUrl('data:text/html,<h1>x</h1>')).toBe(false)
  })

  it('rejects non-strings and junk', () => {
    expect(isSafeExternalUrl(undefined)).toBe(false)
    expect(isSafeExternalUrl(42)).toBe(false)
    expect(isSafeExternalUrl('not a url')).toBe(false)
    expect(isSafeExternalUrl('')).toBe(false)
  })

  // S-URL hardening (B-Finding 14): parse with new URL() and reject embedded
  // credentials and control characters, which can be used to spoof or smuggle.
  it('rejects URLs with embedded credentials', () => {
    expect(isSafeExternalUrl('https://user:pass@evil.example.com/')).toBe(false)
    expect(isSafeExternalUrl('http://admin@localhost:1455/')).toBe(false)
  })

  it('rejects URLs containing control characters (CR/LF/NUL/tab)', () => {
    expect(isSafeExternalUrl('https://example.com/\r\nSet-Cookie: x')).toBe(false)
    expect(isSafeExternalUrl('https://example.com/\x00')).toBe(false)
    expect(isSafeExternalUrl('https://exa\tmple.com/')).toBe(false)
  })

  it('still accepts a normal https URL with a path and query', () => {
    expect(isSafeExternalUrl('https://github.com/login/device?x=1&y=2')).toBe(true)
  })
})
