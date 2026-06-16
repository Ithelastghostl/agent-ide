import { describe, it, expect } from 'vitest'
import { loopbackPort, parseListeningPorts } from '../../src/main/portForwarder'

describe('loopbackPort', () => {
  it('extracts the port from a localhost URL (OAuth callback)', () => {
    expect(loopbackPort('http://localhost:1455/auth/callback?code=abc')).toBe(1455)
  })
  it('handles 127.0.0.1 and arbitrary ports', () => {
    expect(loopbackPort('https://127.0.0.1:3000/')).toBe(3000)
    expect(loopbackPort('http://localhost:8080')).toBe(8080)
  })
  it('defaults to 80 when no port is given', () => {
    expect(loopbackPort('http://localhost/')).toBe(80)
  })
  it('returns null for non-loopback hosts', () => {
    expect(loopbackPort('https://example.com/path')).toBeNull()
    expect(loopbackPort('http://notlocalhost:1455/')).toBeNull()
    expect(loopbackPort('http://localhostx:1455/')).toBeNull()
  })
  it('returns null for non-http(s) or junk', () => {
    expect(loopbackPort('ftp://localhost:21/')).toBeNull()
    expect(loopbackPort('not a url')).toBeNull()
  })
})

describe('parseListeningPorts', () => {
  // Real `ss -ltn` output shape.
  const ss = [
    'State    Recv-Q Send-Q Local Address:Port  Peer Address:Port Process',
    'LISTEN   0      128        127.0.0.1:1455       0.0.0.0:*',
    'LISTEN   0      511          0.0.0.0:3000       0.0.0.0:*',
    'LISTEN   0      4096           [::1]:5173          [::]:*',
    'LISTEN   0      128              *:8000             *:*'
  ].join('\n')

  it('extracts loopback/any listening ports', () => {
    expect(parseListeningPorts(ss).sort((a, b) => a - b)).toEqual([1455, 3000, 5173, 8000])
  })
  it('ignores non-LISTEN lines and the header', () => {
    expect(parseListeningPorts('State Local Address:Port\nESTAB 0 0 127.0.0.1:1455 1.2.3.4:55')).toEqual([])
  })
  it('skips our own bridge-relay port range (40000–59999) to avoid forwarding forwards', () => {
    expect(parseListeningPorts('LISTEN 0 64 0.0.0.0:41455 0.0.0.0:*')).toEqual([])
  })
  it('returns [] for empty / garbage', () => {
    expect(parseListeningPorts('')).toEqual([])
    expect(parseListeningPorts('nonsense')).toEqual([])
  })
})
