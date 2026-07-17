import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cpSync, mkdtempSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import {
  upDevcontainer, findRunningContainer, resolveContainerUser, resolveContainerHome,
  containerWorkspaceFolder, containerExecArgv,
  providerSeedFiles, seedCredentialsInContainer
} from '../../src/main/devcontainer'
import { PortForwarder } from '../../src/main/portForwarder'
import { probeHealth } from '../../src/main/providerHealth'

const pexec = promisify(execFile)

// B4: the real containers-on-OrbStack smoke. Gated behind an env var — it pulls
// images, builds a container, and needs Docker, so it is NOT part of `npm test`.
// Run: AGENT_IDE_CONTAINER_SMOKE=1 npx vitest run tests/integration --testTimeout=600000
const enabled = !!process.env.AGENT_IDE_CONTAINER_SMOKE

describe.skipIf(!enabled)('containers end-to-end on this machine (B4)', () => {
  let workspace: string
  let containerId: string
  let user: string | null
  let home: string
  let wsFolder: string

  beforeAll(async () => {
    // Fresh unique workspace per run (R2-8: never docker rm someone's container
    // — a new workspace label always yields a brand-new container).
    workspace = mkdtempSync(join(tmpdir(), 'agide-smoke-'))
    cpSync(join(__dirname, '..', 'fixtures', 'container-project'), workspace, { recursive: true })

    const up = await upDevcontainer(workspace, [])
    containerId = up.containerId

    user = await resolveContainerUser(containerId)
    home = await resolveContainerHome(containerId, user)
    wsFolder = await containerWorkspaceFolder(workspace)

    // The app's real post-up step: docker-cp seeds into writable state.
    await seedCredentialsInContainer(containerId, user, home, providerSeedFiles(homedir(), { includeClaude: false }))
  }, 600_000)

  afterAll(async () => {
    // Stop (never remove — the user decides deletions); handoff lists leftovers.
    if (containerId) await pexec('docker', ['stop', containerId]).catch(() => {})
  }, 60_000)

  it('resolves the devcontainer exec context authoritatively', async () => {
    expect(user).toBe('node')
    expect(home).toBe('/home/node')
    expect(wsFolder).toBe(`/workspaces/${workspace.split('/').pop()}`)
    expect(await findRunningContainer(workspace)).toBe(containerId)
  })

  it('execs with the session context: pwd, HOME, and whoami all match (R3-1)', async () => {
    const argv = containerExecArgv(containerId, 'sh', ['-c', 'echo "$(whoami) $HOME $(pwd)"'], {
      interactive: false, user: user ?? undefined, cwd: wsFolder, env: { HOME: home }
    })
    const { stdout } = await pexec('docker', argv)
    expect(stdout.trim()).toBe(`node /home/node ${wsFolder}`)
  })

  it('seeded codex credentials are present, WRITABLE, owned by the session user, and authenticated (R3-2)', async () => {
    // live state writable by the session user (a copy, not a host mount)
    const rwCheck = containerExecArgv(containerId, 'sh', ['-c', `test -w ${home}/.codex/auth.json && touch ${home}/.codex/history.jsonl && echo RW`], {
      interactive: false, user: user ?? undefined, env: { HOME: home }
    })
    expect((await pexec('docker', rwCheck)).stdout).toContain('RW')
    // idempotent: reseeding leaves existing container-local files untouched
    const mtimeOf = async () => (await pexec('docker', containerExecArgv(containerId, 'sh', ['-c', `stat -c %Y ${home}/.codex/auth.json`], { interactive: false }))).stdout.trim()
    const before = await mtimeOf()
    await new Promise((r) => setTimeout(r, 1100)) // mtime granularity
    await seedCredentialsInContainer(containerId, user, home, providerSeedFiles(homedir(), { includeClaude: false }))
    expect(await mtimeOf()).toBe(before)
    // real auth through the app's health path (presence AND login status)
    const health = await probeHealth('codex', { containerId, user: user ?? undefined, home, cwd: wsFolder })
    expect(health).toBe('healthy')
  }, 120_000)

  it('forwards an in-container port to the host (OrbStack bridge-IP hop)', async () => {
    // Start a listener inside the container, then forward it with the app's
    // real PortForwarder (python relay + host Node relay) and round-trip TCP.
    const port = 8123
    await pexec('docker', containerExecArgv(containerId, 'sh', ['-c',
      `nohup python3 -m http.server ${port} --bind 127.0.0.1 >/dev/null 2>&1 & sleep 1`], { interactive: false }))
    const fwd = new PortForwarder()
    const ok = await fwd.ensure(containerId, port, 'smoke-test')
    expect(ok).toBe(true)
    // The in-container relay starts detached — retry while it binds (the app's
    // watcher naturally retries; a raw first-connection can race it).
    // Resolve as soon as the status line arrives — the relayed socket may stay
    // half-open (no 'end'), which is fine for the browsers/OAuth flows it serves.
    const tryOnce = () => new Promise<string>((resolve, reject) => {
      const sock = connect(port, '127.0.0.1', () => { sock.write('GET / HTTP/1.0\r\n\r\n') })
      let data = ''
      const done = () => { sock.destroy(); resolve(data) }
      sock.on('data', (d) => { data += d.toString(); if (data.includes('HTTP/1.0 200')) done() })
      sock.on('end', done)
      sock.on('error', reject)
      setTimeout(done, 5_000)
    })
    let body = ''
    for (let i = 0; i < 8 && !body.includes('HTTP/1.0 200'); i++) {
      body = await tryOnce().catch(() => '')
      if (!body.includes('HTTP/1.0 200')) await new Promise((r) => setTimeout(r, 1000))
    }
    expect(body).toContain('HTTP/1.0 200')
    await fwd.disposeAll()
    // teardown killed the in-container relay
    // bracket class so the probe's own cmdline can't self-match
    const { stdout } = await pexec('docker', containerExecArgv(containerId, 'sh', ['-c', 'pgrep -f "agentide-fw[d]" || echo NONE'], { interactive: false }))
    expect(stdout).toContain('NONE')
  }, 120_000)

  it('runs a REAL interactive codex session in the container (writable state proven)', async () => {
    // node-pty drives `docker exec -it … codex` exactly like session:launch.
    const pty = await import('node-pty')
    const argv = containerExecArgv(containerId, 'codex', ['-m', 'gpt-5-codex'], {
      user: user ?? undefined, cwd: wsFolder, env: { HOME: home }
    })
    const out: string[] = []
    const proc = pty.spawn('docker', argv, { name: 'xterm-color', cols: 120, rows: 40, cwd: workspace, env: process.env as Record<string, string> })
    proc.onData((d) => out.push(d))
    // The fresh workspace triggers codex's directory-trust dialog first —
    // answer it (Enter = "Yes, continue"), then wait for the main TUI.
    let trusted = false
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`codex TUI never became ready. Output tail: ${out.join('').slice(-2000)}`)), 90_000)
      const iv = setInterval(() => {
        const text = out.join('')
        if (!trusted && /trust/i.test(text) && /continue/i.test(text)) {
          trusted = true
          out.length = 0 // only count post-trust output as the real TUI
          proc.write('\r')
          return
        }
        if (trusted && out.join('').length > 500) {
          clearTimeout(timer); clearInterval(iv); resolve()
        }
      }, 500)
    })
    proc.kill()
    expect(trusted).toBe(true)
    expect(out.join('').length).toBeGreaterThan(500)
  }, 180_000)
})
