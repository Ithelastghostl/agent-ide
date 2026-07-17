import type { SpawnOpts, ExitReason } from '../ptyManager'
import type { ContainerPresence } from '../devcontainer'
import type { Health, RunContext } from '../providerHealth'
import type { Provider } from '@shared/types'

// M1: the platform-runtime seam. These interfaces capture ONLY the
// side-effecting platform operations (node-pty, docker, host commands, net
// relays) — the pure argv/mount/parse builders stay as free functions that the
// consumers call before dispatching. The Linux implementation (runtime/linux.ts)
// delegates to the existing modules verbatim; M2 (Win32) / M3 (Darwin) / M4
// (Docker Desktop) provide alternative implementations of the same interfaces.
//
// Exit criterion: no platform-specific COMMANDS live outside runtime/. Pure
// builders (containerExecArgv, *ConfigMount, launchArgv, loginArgv, loopbackPort)
// are platform-agnostic and remain in their modules.

/** PTY lifecycle. Linux/macOS: node-pty. Windows: ConPTY (M2). */
export interface TerminalRuntime {
  spawn(
    o: SpawnOpts,
    onData: (d: string) => void,
    onExit?: (info: { exitCode: number; signal?: number; reason: ExitReason }) => void
  ): string
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  kill(id: string): void
  /** Whether a live pty exists for this session — lets a reopened window attach
   *  to surviving sessions instead of offering a killing "reconnect". */
  has(id: string): boolean
  /** Write a history primer once the terminal settles (B12). */
  primeWhenReady(id: string, data: string, opts?: { quietMs?: number; maxWaitMs?: number }): void
}

/** Devcontainer / Docker operations. Linux: docker CLI. Win/mac: Docker Desktop (M4). */
export interface ContainerRuntime {
  up(workspace: string, mounts?: string[]): Promise<{ containerId: string }>
  hasCli(): Promise<boolean>
  findRunning(workspace: string): Promise<string | null>
  findPresence(workspace: string): Promise<ContainerPresence>
  startById(id: string): Promise<void>
  /** `docker stop` — reversible; preserves container state for a fast restart. */
  stopById(id: string): Promise<void>
  /** The non-root user to `docker exec` as (devcontainer remoteUser / uid≥1000). */
  resolveUser(containerId: string): Promise<string | null>
  /** That user's home from the container's passwd (R3-1); conventional fallback. */
  resolveHome(containerId: string, user: string | null): Promise<string>
  /** Container-side workspace folder (merged devcontainer configuration). */
  workspaceFolder(workspace: string): Promise<string>
  /** Copy host credentials into writable container state via docker cp (R3-2);
   *  idempotent, container-local files always win. */
  seedCredentials(
    containerId: string,
    user: string | null,
    home: string,
    files: import('../devcontainer').SeedFile[]
  ): Promise<void>
}

/** Host-level provider operations (health probing + in-container install). Runs
 *  provider CLIs on the host or via `docker exec`. Win/mac differ in shell/PATH. */
export interface HostRuntime {
  probeHealth(provider: Provider, ctx: RunContext): Promise<Health>
  installInContainer(provider: Provider, containerId: string): Promise<void>
}

/** A running port watcher for one container; stop() releases its forwards. */
export interface PortWatchHandle {
  start(): void
  stop(): Promise<void>
}

/** Forwards in-container localhost ports out to the host (net.Server + relay),
 *  refcounted per (container, port). Linux today; Docker-native on Win/mac (M4). */
export interface PortForwardService {
  ensure(containerId: string, port: number, owner: string): Promise<boolean>
  release(containerId: string, port: number, owner: string): Promise<void>
  disposeAll(): Promise<void>
  /** A watcher that auto-forwards each newly-listening container port. */
  watch(
    containerId: string,
    opts: { onForward?: (port: number) => void; owner?: string; intervalMs?: number }
  ): PortWatchHandle
}

/** The bundle of platform runtimes handed to the IPC layer. One concrete
 *  implementation per platform; ipc.ts is platform-agnostic above it. */
export interface Runtime {
  terminal: TerminalRuntime
  container: ContainerRuntime
  host: HostRuntime
  ports: PortForwardService
}
