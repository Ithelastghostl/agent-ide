import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer, connect, type Server, type Socket } from 'node:net'

const pexec = promisify(execFile)

/** A relay script (TCP splice) run via python3 INSIDE the container (which the
 *  devcontainer image ships). Listens on 0.0.0.0:bridgePort and pipes every
 *  connection to 127.0.0.1:servicePort. The host hop is a Node net.Server (see
 *  PortForwarder) — only the in-container hop stays python, to avoid a rebuild. */
function relayPy(bindHost: string, listenPort: number, dialHost: string, dialPort: number): string {
  return `
import socket, threading, sys
def pipe(a, b):
    try:
        while True:
            d = a.recv(65536)
            if not d: break
            b.sendall(d)
    except Exception:
        pass
    finally:
        for s in (a, b):
            try: s.close()
            except Exception: pass
srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind((${JSON.stringify(bindHost)}, ${listenPort}))
srv.listen(64)
while True:
    c, _ = srv.accept()
    try:
        u = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        u.connect((${JSON.stringify(dialHost)}, ${dialPort}))
    except Exception:
        try: c.close()
        except Exception: pass
        continue
    threading.Thread(target=pipe, args=(c, u), daemon=True).start()
    threading.Thread(target=pipe, args=(u, c), daemon=True).start()
`.trim()
}

/** Find a running container's bridge IP (reachable from the host). */
export async function containerIp(containerId: string): Promise<string | null> {
  try {
    const { stdout } = await pexec('docker', [
      'inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', containerId
    ])
    const ip = stdout.trim()
    return ip || null
  } catch {
    return null
  }
}

/** B10: pick a bridge port that is not already in use, instead of deriving one
 *  from the service port (`40000 + port % 20000` collided, e.g. 1455 vs 21455).
 *  First free port at/after 40000 not in `used`. Pure + deterministic. */
export function allocBridgePort(used: Set<number>): number {
  for (let p = 40000; p < 60000; p++) {
    if (!used.has(p)) return p
  }
  throw new Error('no free bridge port in 40000–59999')
}

/** Dependencies the forwarder needs, injectable so the relay lifecycle can be
 *  unit-tested without Docker. */
export interface PortForwarderDeps {
  containerIp: (containerId: string) => Promise<string | null>
  /** Start the in-container relay: 0.0.0.0:bridgePort → 127.0.0.1:servicePort. */
  dockerExec: (containerId: string, bridgePort: number, servicePort: number, marker: string) => Promise<void>
  /** Kill the in-container relay tagged with `marker`. */
  dockerKill?: (containerId: string, marker: string) => Promise<void>
}

const realDeps: PortForwarderDeps = {
  containerIp,
  dockerExec: async (containerId, bridgePort, servicePort, marker) => {
    await pexec('docker', [
      'exec', '-d', containerId,
      'python3', '-c', relayPy('0.0.0.0', bridgePort, '127.0.0.1', servicePort) + `\n# ${marker}`
    ])
  },
  dockerKill: async (containerId, marker) => {
    await pexec('docker', ['exec', containerId, 'pkill', '-f', marker])
  }
}

interface Forward {
  server: Server // host-side Node relay listening on 127.0.0.1:servicePort
  sockets: Set<Socket> // live spliced connections, for a clean teardown
  bridgePort: number
  marker: string
  owners: Set<string> // B5: refcount — the forward lives until the last owner releases
}

/** Forwards container `localhost:<port>` out to the HOST's `localhost:<port>`, the
 *  way VS Code does, so a browser on the host can reach a service the agent runs
 *  inside the container (dev servers, OAuth loopback callbacks like :1455, …).
 *
 *  Two hops:
 *    host 127.0.0.1:port (Node net.Server)  ──►  containerIP:bridgePort  ──►  container 127.0.0.1:port (python)
 *
 *  Refcounted per (container, port): multiple sessions can share one forward and
 *  it is torn down only when the last owner releases it (B5). The host hop
 *  succeeds only once it is actually listening, and fails cleanly on a bind error
 *  (B4). The bridge port is allocated dynamically to avoid collisions (B10). */
export class PortForwarder {
  private active = new Map<string, Forward>()
  private usedBridgePorts = new Set<number>()
  private readonly deps: PortForwarderDeps
  /** Test-only: force the host relay to dial this port on the container IP,
   *  standing in for the in-container relay's bridge port. */
  _dialPortForTest?: number

  constructor(deps: Partial<PortForwarderDeps> = {}) {
    this.deps = { ...realDeps, ...deps }
  }

  private key(containerId: string, port: number): string {
    return `${containerId}:${port}`
  }

  isActive(containerId: string, port: number): boolean {
    return this.active.has(this.key(containerId, port))
  }

  /** Ensure container `port` is reachable at host `localhost:<port>` on behalf of
   *  `owner`. Returns true once a forward is in place (or already was). Idempotent
   *  per (container, port); repeat callers just add themselves as owners (B5). */
  async ensure(containerId: string, port: number, owner: string): Promise<boolean> {
    const key = this.key(containerId, port)
    const existing = this.active.get(key)
    if (existing) {
      existing.owners.add(owner)
      return true
    }

    const ip = await this.deps.containerIp(containerId)
    if (!ip) return false

    const bridgePort = allocBridgePort(this.usedBridgePorts)
    this.usedBridgePorts.add(bridgePort)
    const marker = `agentide-fwd-${port}-${bridgePort}`

    // 1) In-container relay: 0.0.0.0:bridgePort → 127.0.0.1:port.
    try {
      await this.deps.dockerExec(containerId, bridgePort, port, marker)
    } catch {
      this.usedBridgePorts.delete(bridgePort)
      return false
    }

    // 2) Host relay: a Node net.Server on 127.0.0.1:port that splices each
    //    connection to (ip, bridgePort). Only report success once it is LISTENING;
    //    fail (and clean up the container relay) on a bind error (B4).
    const dialPort = this._dialPortForTest ?? bridgePort
    const sockets = new Set<Socket>()
    const server = createServer((client) => {
      const upstream = connect(dialPort, ip)
      sockets.add(client); sockets.add(upstream)
      const drop = (s: Socket) => { sockets.delete(s); try { s.destroy() } catch { /* */ } }
      client.on('error', () => drop(client))
      upstream.on('error', () => { drop(client); drop(upstream) })
      client.on('close', () => drop(client))
      upstream.on('close', () => drop(upstream))
      client.pipe(upstream); upstream.pipe(client)
    })

    const listening = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false)) // e.g. EADDRINUSE
      server.listen(port, '127.0.0.1', () => resolve(true))
    })
    if (!listening) {
      try { server.close() } catch { /* */ }
      this.usedBridgePorts.delete(bridgePort)
      await this.deps.dockerKill?.(containerId, marker).catch(() => {})
      return false
    }
    // If the app exits, remove the record when the server closes.
    server.on('close', () => { this.active.delete(key); this.usedBridgePorts.delete(bridgePort) })

    this.active.set(key, { server, sockets, bridgePort, marker, owners: new Set([owner]) })
    return true
  }

  /** Release one owner's claim on a forward. The forward is torn down only when
   *  the last owner releases it (B5). */
  async release(containerId: string, port: number, owner: string): Promise<void> {
    const key = this.key(containerId, port)
    const f = this.active.get(key)
    if (!f) return
    f.owners.delete(owner)
    if (f.owners.size > 0) return // still in use by another session
    await this.teardown(containerId, key, f)
  }

  private async teardown(containerId: string, key: string, f: Forward): Promise<void> {
    this.active.delete(key)
    this.usedBridgePorts.delete(f.bridgePort)
    for (const s of f.sockets) { try { s.destroy() } catch { /* */ } }
    f.sockets.clear()
    try { f.server.close() } catch { /* already closed */ }
    await this.deps.dockerKill?.(containerId, f.marker).catch(() => {})
  }

  /** Kill every host-side relay (app shutdown). Container relays die with the
   *  container, but we best-effort pkill them too. */
  async disposeAll(): Promise<void> {
    const entries = [...this.active.entries()]
    this.active.clear()
    this.usedBridgePorts.clear()
    await Promise.all(entries.map(async ([key, f]) => {
      const containerId = key.slice(0, key.lastIndexOf(':'))
      for (const s of f.sockets) { try { s.destroy() } catch { /* */ } }
      try { f.server.close() } catch { /* */ }
      await this.deps.dockerKill?.(containerId, f.marker).catch(() => {})
    }))
  }
}

/** Extract a localhost port from a URL, or null if it isn't a loopback URL.
 *  Matches http(s)://localhost:PORT and 127.0.0.1:PORT (any path/query). */
export function loopbackPort(url: string): number | null {
  const m = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::(\d{1,5}))?(?:[/?#]|$)/i.exec(url)
  if (!m) return null
  const port = m[1] ? Number(m[1]) : 80
  return port > 0 && port <= 65535 ? port : null
}

/** Parse `ss -ltn` (or `netstat -ltn`) output and return the set of TCP ports a
 *  process is LISTENING on at a loopback/any address (127.0.0.1, ::1, 0.0.0.0, *).
 *  Excludes our own bridge relays (ports >= 40000 in the derived range) so the
 *  watcher doesn't forward its own forwards. */
export function parseListeningPorts(ssOutput: string): number[] {
  const ports = new Set<number>()
  for (const line of ssOutput.split('\n')) {
    if (!/LISTEN/.test(line)) continue
    // Local Address:Port is the 4th column for ss, e.g. "127.0.0.1:1455" or "*:3000".
    // Match the LAST :PORT on a loopback/any local address token.
    const m = line.match(/(?:127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\*|::):(\d{1,5})\b/)
    if (!m) continue
    const port = Number(m[1])
    if (port > 0 && port <= 65535 && !(port >= 40000 && port < 60000)) ports.add(port)
  }
  return [...ports]
}

/** List the loopback/any TCP ports currently being listened on INSIDE a container. */
export async function listeningPorts(containerId: string): Promise<number[]> {
  try {
    const { stdout } = await pexec('docker', [
      'exec', containerId, 'sh', '-c', '(ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) || true'
    ])
    return parseListeningPorts(stdout)
  } catch {
    return []
  }
}

/** Watches a container for newly-opened listening ports and auto-forwards each to
 *  the same host port (VS Code-style). Refcounted per container in the caller
 *  (ipc.ts): one watcher per container regardless of how many sessions use it, so
 *  a session ending never tears down another session's forwards (B5). Ports that
 *  vanish stay forwarded (cheap, avoids churn if a server restarts). */
export class ContainerPortWatcher {
  private timer: ReturnType<typeof setInterval> | null = null
  private forwarded = new Set<number>()

  constructor(
    private readonly containerId: string,
    private readonly forwarder: PortForwarder,
    private readonly opts: { intervalMs?: number; onForward?: (port: number) => void; owner?: string } = {}
  ) {}

  private get owner(): string {
    // One watcher per container; use the container id as the forward owner so all
    // ports it opens are released together when the watcher stops.
    return this.opts.owner ?? `watcher:${this.containerId}`
  }

  /** Begin polling. Safe to call once; re-calling is a no-op. */
  start(): void {
    if (this.timer) return
    const tick = async () => {
      const ports = await listeningPorts(this.containerId)
      for (const port of ports) {
        if (this.forwarded.has(port)) continue
        this.forwarded.add(port)
        const ok = await this.forwarder.ensure(this.containerId, port, this.owner)
        if (ok) this.opts.onForward?.(port)
        else this.forwarded.delete(port) // retry next tick if it failed
      }
    }
    void tick() // immediate first pass so a login port is caught fast
    this.timer = setInterval(() => void tick(), this.opts.intervalMs ?? 1000)
  }

  /** Stop polling and release this watcher's claim on every forward it made. */
  async stop(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    const ports = [...this.forwarded]
    this.forwarded.clear()
    await Promise.all(ports.map((p) => this.forwarder.release(this.containerId, p, this.owner)))
  }
}
