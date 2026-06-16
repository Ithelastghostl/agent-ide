import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'

const pexec = promisify(execFile)

/** A relay script (TCP splice) run via python3, which both the host and the
 *  devcontainer image already ship. Listens on (bindHost, listenPort) and pipes
 *  every connection to (dialHost, dialPort). Kept dependency-free on purpose. */
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

/** Forwards container `localhost:<port>` out to the HOST's `localhost:<port>`, the
 *  way VS Code does, so a browser on the host can reach a service the agent runs
 *  inside the container (dev servers, OAuth loopback callbacks like :1455, …).
 *
 *  Two hops, both python3 (no extra deps, no container rebuild):
 *    host 127.0.0.1:port  ──►  containerIP:bridgePort  ──►  container 127.0.0.1:port
 *  The in-container relay binds 0.0.0.0:bridgePort so the host can reach it over
 *  the bridge IP; the host relay re-exposes it on the same localhost:port the URL
 *  names. Idempotent per (container, port). */
export class PortForwarder {
  // key = `${containerId}:${port}` → handles so we don't double-forward / can stop.
  private active = new Map<string, { hostProc: ReturnType<typeof spawn>; containerKillId: string }>()

  /** Ensure container `port` is reachable at host `localhost:<port>`. Returns true
   *  once a forward is in place (or already was). */
  async ensure(containerId: string, port: number): Promise<boolean> {
    const key = `${containerId}:${port}`
    if (this.active.has(key)) return true

    const ip = await containerIp(containerId)
    if (!ip) return false

    // The in-container relay must bind a DIFFERENT port than the service: binding
    // 0.0.0.0:port would collide with the service already on 127.0.0.1:port (the
    // wildcard address includes loopback), so the relay's bind fails and the
    // connection hangs. Use a stable high bridge port derived from the original.
    const bridgePort = 40000 + (port % 20000)

    // 1) In-container relay: 0.0.0.0:bridgePort → 127.0.0.1:port. Detached via
    //    `docker exec -d`; tagged with a marker arg so we can pkill it on stop.
    const marker = `agentide-fwd-${port}`
    try {
      await pexec('docker', [
        'exec', '-d', containerId,
        'python3', '-c', relayPy('0.0.0.0', bridgePort, '127.0.0.1', port) + `\n# ${marker}`
      ])
    } catch {
      return false
    }

    // 2) Host relay: 127.0.0.1:port → containerIP:bridgePort. Long-lived child of
    //    the app; killed when we stop forwarding or the app exits.
    const hostProc = spawn('python3', ['-c', relayPy('127.0.0.1', port, ip, bridgePort)], {
      stdio: 'ignore',
      detached: false
    })
    hostProc.on('error', () => this.active.delete(key))

    this.active.set(key, { hostProc, containerKillId: marker })
    return true
  }

  /** Tear down a single forward. */
  async stop(containerId: string, port: number): Promise<void> {
    const key = `${containerId}:${port}`
    const h = this.active.get(key)
    if (!h) return
    this.active.delete(key)
    try { h.hostProc.kill() } catch { /* already gone */ }
    try { await pexec('docker', ['exec', containerId, 'pkill', '-f', h.containerKillId]) } catch { /* container gone */ }
  }

  /** Kill every host-side relay (app shutdown). Container relays die with the container. */
  disposeAll(): void {
    for (const { hostProc } of this.active.values()) {
      try { hostProc.kill() } catch { /* ignore */ }
    }
    this.active.clear()
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
 *  the same host port (VS Code-style). One watcher per session; stop() ends the
 *  poll and tears down the forwards it created. Ports that vanish stay forwarded
 *  (cheap, and avoids churn if a server restarts); everything is cleaned on stop. */
export class ContainerPortWatcher {
  private timer: ReturnType<typeof setInterval> | null = null
  private forwarded = new Set<number>()

  constructor(
    private readonly containerId: string,
    private readonly forwarder: PortForwarder,
    private readonly opts: { intervalMs?: number; onForward?: (port: number) => void } = {}
  ) {}

  /** Begin polling. Safe to call once; re-calling is a no-op. */
  start(): void {
    if (this.timer) return
    const tick = async () => {
      const ports = await listeningPorts(this.containerId)
      for (const port of ports) {
        if (this.forwarded.has(port)) continue
        this.forwarded.add(port)
        const ok = await this.forwarder.ensure(this.containerId, port)
        if (ok) this.opts.onForward?.(port)
        else this.forwarded.delete(port) // retry next tick if it failed
      }
    }
    void tick() // immediate first pass so a login port is caught fast
    this.timer = setInterval(() => void tick(), this.opts.intervalMs ?? 1000)
  }

  /** Stop polling and tear down every forward this watcher established. */
  async stop(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    const ports = [...this.forwarded]
    this.forwarded.clear()
    await Promise.all(ports.map((p) => this.forwarder.stop(this.containerId, p)))
  }
}
