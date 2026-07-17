import type { Provider } from '@shared/types'
import type { SpawnOpts, ExitReason } from '../ptyManager'
import type { ContainerPresence } from '../devcontainer'
import type { Health, RunContext } from '../providerHealth'
import type {
  TerminalRuntime, ContainerRuntime, HostRuntime, PortForwardService, PortWatchHandle, Runtime
} from './types'

// M1: an in-memory fake Runtime for tests — proves the platform seam is
// implementable and testable WITHOUT real node-pty/docker/net. Records calls so
// tests can assert on them. This is the shape a Win32/Darwin runtime also fills.

export class FakeTerminalRuntime implements TerminalRuntime {
  spawns: SpawnOpts[] = []
  writes: { id: string; data: string }[] = []
  killed: string[] = []
  primed: { id: string; data: string }[] = []
  private live = new Set<string>()
  private onExitById = new Map<string, (info: { exitCode: number; signal?: number; reason: ExitReason }) => void>()

  spawn(o: SpawnOpts, _onData: (d: string) => void, onExit?: (info: { exitCode: number; signal?: number; reason: ExitReason }) => void): string {
    this.spawns.push(o)
    this.live.add(o.id)
    if (onExit) this.onExitById.set(o.id, onExit)
    return o.id
  }
  write(id: string, data: string): void { this.writes.push({ id, data }) }
  resize(): void { /* no-op */ }
  kill(id: string): void {
    this.killed.push(id)
    this.live.delete(id)
    this.onExitById.get(id)?.({ exitCode: 0, reason: 'closed' })
  }
  has(id: string): boolean { return this.live.has(id) }
  primeWhenReady(id: string, data: string): void { this.primed.push({ id, data }) }
  /** test helper: simulate the process dying on its own. */
  crash(id: string): void {
    this.live.delete(id)
    this.onExitById.get(id)?.({ exitCode: 1, reason: 'crashed' })
  }
}

export class FakeContainerRuntime implements ContainerRuntime {
  ups: { workspace: string; mounts: string[] }[] = []
  hasCliResult = true
  presenceByWorkspace = new Map<string, ContainerPresence>()
  runningByWorkspace = new Map<string, string | null>()
  userByContainer = new Map<string, string | null>()
  private seq = 0

  up(workspace: string, mounts: string[] = []): Promise<{ containerId: string }> {
    this.ups.push({ workspace, mounts })
    const containerId = `fake-container-${++this.seq}`
    return Promise.resolve({ containerId })
  }
  hasCli(): Promise<boolean> { return Promise.resolve(this.hasCliResult) }
  findRunning(workspace: string): Promise<string | null> {
    return Promise.resolve(this.runningByWorkspace.get(workspace) ?? null)
  }
  findPresence(workspace: string): Promise<ContainerPresence> {
    return Promise.resolve(this.presenceByWorkspace.get(workspace) ?? { state: 'none' })
  }
  startById(): Promise<void> { return Promise.resolve() }
  stopById(): Promise<void> { return Promise.resolve() }
  resolveUser(containerId: string): Promise<string | null> {
    return Promise.resolve(this.userByContainer.get(containerId) ?? null)
  }
  homeByContainer = new Map<string, string>()
  seeded: { containerId: string; user: string | null; home: string; files: import('../devcontainer').SeedFile[] }[] = []
  resolveHome(containerId: string, user: string | null): Promise<string> {
    return Promise.resolve(this.homeByContainer.get(containerId) ?? (user === 'root' ? '/root' : `/home/${user ?? 'node'}`))
  }
  workspaceFolder(workspace: string): Promise<string> {
    return Promise.resolve(`/workspaces/${workspace.split('/').filter(Boolean).pop() ?? 'workspace'}`)
  }
  seedCredentials(containerId: string, user: string | null, home: string, files: import('../devcontainer').SeedFile[]): Promise<void> {
    this.seeded.push({ containerId, user, home, files })
    return Promise.resolve()
  }
}

export class FakeHostRuntime implements HostRuntime {
  healthResult: Health = 'healthy'
  installed: { provider: Provider; containerId: string }[] = []
  probeHealth(_provider: Provider, _ctx: RunContext): Promise<Health> { return Promise.resolve(this.healthResult) }
  installInContainer(provider: Provider, containerId: string): Promise<void> {
    this.installed.push({ provider, containerId })
    return Promise.resolve()
  }
}

export class FakePortForwardService implements PortForwardService {
  active = new Map<string, Set<string>>() // key -> owners
  disposed = false
  private key(c: string, p: number) { return `${c}:${p}` }
  ensure(containerId: string, port: number, owner: string): Promise<boolean> {
    const k = this.key(containerId, port)
    if (!this.active.has(k)) this.active.set(k, new Set())
    this.active.get(k)!.add(owner)
    return Promise.resolve(true)
  }
  release(containerId: string, port: number, owner: string): Promise<void> {
    const k = this.key(containerId, port)
    const owners = this.active.get(k)
    if (owners) { owners.delete(owner); if (owners.size === 0) this.active.delete(k) }
    return Promise.resolve()
  }
  disposeAll(): Promise<void> { this.disposed = true; this.active.clear(); return Promise.resolve() }
  watch(_containerId: string, _opts: { onForward?: (port: number) => void; owner?: string; intervalMs?: number }): PortWatchHandle {
    return { start: () => { /* no-op */ }, stop: () => Promise.resolve() }
  }
}

/** A full fake Runtime; each part is individually inspectable. */
export function createFakeRuntime(): Runtime & {
  terminal: FakeTerminalRuntime; container: FakeContainerRuntime; host: FakeHostRuntime; ports: FakePortForwardService
} {
  return {
    terminal: new FakeTerminalRuntime(),
    container: new FakeContainerRuntime(),
    host: new FakeHostRuntime(),
    ports: new FakePortForwardService()
  }
}
