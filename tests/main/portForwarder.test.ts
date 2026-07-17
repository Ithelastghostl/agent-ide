import { describe, it, expect } from 'vitest'
import { createServer, connect, type Server } from 'node:net'
import {
  loopbackPort,
  parseListeningPorts,
  PortForwarder,
  allocBridgePort
} from '../../src/main/portForwarder'

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

describe('allocBridgePort (B10: no derivation collision)', () => {
  it('gives distinct ports even for inputs that collided under 40000+port%20000', () => {
    const used = new Set<number>()
    // 1455 and 21455 both mapped to 41455 under the old modulo scheme.
    const a = allocBridgePort(used)
    used.add(a)
    const b = allocBridgePort(used)
    used.add(b)
    expect(a).not.toBe(b)
    expect(a).toBeGreaterThanOrEqual(40000)
    expect(b).toBeGreaterThanOrEqual(40000)
  })
  it('never returns a port already in the used set', () => {
    const used = new Set<number>([40000, 40001, 40002])
    const p = allocBridgePort(used)
    expect(used.has(p)).toBe(false)
  })
})

// PortForwarder is refactored with injectable seams so the relay lifecycle can be
// tested without Docker: `containerIp` and `dockerExec` are overridable. The
// host hop is a real Node net.Server bound to loopback, so B4 (succeed only once
// listening) is exercised for real against a local echo server standing in for
// the container.
describe('PortForwarder (B4 listen-gating, B5 refcount, B10 alloc)', () => {
  // A local echo server that plays "the in-container service" reached via the
  // (faked) container IP. The forwarder's host relay should splice to it.
  function echoServer(): Promise<{ server: Server; port: number }> {
    return new Promise((resolve) => {
      const server = createServer((sock) => sock.pipe(sock)) // echo back
      server.listen(0, '127.0.0.1', () => {
        resolve({ server, port: (server.address() as { port: number }).port })
      })
    })
  }

  function roundTrip(port: number, payload: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const c = connect(port, '127.0.0.1', () => c.write(payload))
      let buf = ''
      c.on('data', (d) => {
        buf += d.toString()
        c.end()
      })
      c.on('end', () => resolve(buf))
      c.on('error', reject)
    })
  }

  it('B4: ensure() resolves true only after the host relay is actually listening', async () => {
    const echo = await echoServer()
    // fake container: its "IP" is loopback, its "service port" is the echo port.
    // The in-container relay is faked (dockerExec no-op) so the host relay dials
    // the echo server directly via the bridge port we pretend it bound.
    const fwd = new PortForwarder({
      containerIp: async () => '127.0.0.1',
      // pretend the in-container relay bound `bridgePort` forwarding to the service;
      // we simply make the host relay dial the echo server's real port instead.
      dockerExec: async () => {}
    })
    // Override the dial target: the host relay should dial (ip, bridgePort); we
    // want it to actually reach the echo server, so we expose a test hook.
    fwd._dialPortForTest = echo.port

    const ok = await fwd.ensure('cX', 7777, 'ownerA')
    expect(ok).toBe(true)
    // the host relay listens on the SAME port the URL names (7777)
    const reply = await roundTrip(7777, 'ping')
    expect(reply).toBe('ping') // spliced through to the echo server

    await fwd.disposeAll()
    echo.server.close()
  })

  it('B4: ensure() resolves false when the host port cannot be bound', async () => {
    // Occupy 7778 first so the relay's bind fails.
    const blocker = createServer(() => {})
    await new Promise<void>((r) => blocker.listen(7778, '127.0.0.1', r))
    const fwd = new PortForwarder({ containerIp: async () => '127.0.0.1', dockerExec: async () => {} })
    const ok = await fwd.ensure('cX', 7778, 'ownerA')
    expect(ok).toBe(false)
    await fwd.disposeAll()
    blocker.close()
  })

  it('B4: ensure() resolves false when the container has no IP', async () => {
    const fwd = new PortForwarder({ containerIp: async () => null, dockerExec: async () => {} })
    expect(await fwd.ensure('cX', 7779, 'ownerA')).toBe(false)
    await fwd.disposeAll()
  })

  it('B5: a shared (container,port) survives until the LAST owner releases', async () => {
    const echo = await echoServer()
    const fwd = new PortForwarder({ containerIp: async () => '127.0.0.1', dockerExec: async () => {} })
    fwd._dialPortForTest = echo.port

    expect(await fwd.ensure('cShared', 6000, 'session1')).toBe(true)
    expect(await fwd.ensure('cShared', 6000, 'session2')).toBe(true) // second owner, same forward
    expect(fwd.isActive('cShared', 6000)).toBe(true)

    // session1 leaves — forward MUST stay up for session2 (this is the B5 bug)
    await fwd.release('cShared', 6000, 'session1')
    expect(fwd.isActive('cShared', 6000)).toBe(true)
    expect(await roundTrip(6000, 'still-up')).toBe('still-up')

    // last owner leaves — now it tears down
    await fwd.release('cShared', 6000, 'session2')
    expect(fwd.isActive('cShared', 6000)).toBe(false)

    await fwd.disposeAll()
    echo.server.close()
  })

  it('B10: two forwards whose ports collided under the old modulo get distinct bridge ports', async () => {
    const echo = await echoServer()
    const bridges: number[] = []
    const fwd = new PortForwarder({
      containerIp: async () => '127.0.0.1',
      dockerExec: async (_id, bridgePort) => {
        bridges.push(bridgePort)
      }
    })
    fwd._dialPortForTest = echo.port
    // 1455 and 21455 collided to 41455 under 40000+port%20000
    await fwd.ensure('cColl', 1455, 'o1')
    await fwd.ensure('cColl', 21455, 'o2')
    expect(bridges).toHaveLength(2)
    expect(bridges[0]).not.toBe(bridges[1])
    await fwd.disposeAll()
    echo.server.close()
  })
})
