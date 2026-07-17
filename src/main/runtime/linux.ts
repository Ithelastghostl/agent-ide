import type { Provider } from '@shared/types'
import { PtyManager, type SpawnOpts, type ExitReason } from '../ptyManager'
import {
  upDevcontainer, hasDevcontainerCli, findRunningContainer, findContainerPresence,
  startContainerById, stopContainerById, resolveContainerUser, resolveContainerHome, containerWorkspaceFolder,
  seedCredentialsInContainer, type ContainerPresence, type SeedFile
} from '../devcontainer'
import { probeHealth, installInContainer, type Health, type RunContext } from '../providerHealth'
import { PortForwarder, ContainerPortWatcher } from '../portForwarder'
import type {
  TerminalRuntime, ContainerRuntime, HostRuntime, PortForwardService, PortWatchHandle, Runtime
} from './types'

// M1: the Linux implementation of the runtime seam. Each class delegates to the
// existing, already-debugged modules VERBATIM (strangler-fig — behavior is
// unchanged; only the dispatch is now behind an interface). This is the only
// place Linux's node-pty/docker commands are wired.

class LinuxTerminalRuntime implements TerminalRuntime {
  private readonly pty = new PtyManager()
  spawn(
    o: SpawnOpts,
    onData: (d: string) => void,
    onExit?: (info: { exitCode: number; signal?: number; reason: ExitReason }) => void
  ): string {
    return this.pty.spawn(o, onData, onExit)
  }
  write(id: string, data: string): void { this.pty.write(id, data) }
  resize(id: string, cols: number, rows: number): void { this.pty.resize(id, cols, rows) }
  kill(id: string): void { this.pty.kill(id) }
  has(id: string): boolean { return this.pty.has(id) }
  primeWhenReady(id: string, data: string, opts?: { quietMs?: number; maxWaitMs?: number }): void {
    this.pty.primeWhenReady(id, data, opts)
  }
}

class LinuxContainerRuntime implements ContainerRuntime {
  up(workspace: string, mounts: string[] = []): Promise<{ containerId: string }> {
    return upDevcontainer(workspace, mounts)
  }
  hasCli(): Promise<boolean> { return hasDevcontainerCli() }
  findRunning(workspace: string): Promise<string | null> { return findRunningContainer(workspace) }
  findPresence(workspace: string): Promise<ContainerPresence> { return findContainerPresence(workspace) }
  startById(id: string): Promise<void> { return startContainerById(id) }
  stopById(id: string): Promise<void> { return stopContainerById(id) }
  resolveUser(containerId: string): Promise<string | null> { return resolveContainerUser(containerId) }
  resolveHome(containerId: string, user: string | null): Promise<string> { return resolveContainerHome(containerId, user) }
  workspaceFolder(workspace: string): Promise<string> { return containerWorkspaceFolder(workspace) }
  seedCredentials(containerId: string, user: string | null, home: string, files: SeedFile[]): Promise<void> {
    return seedCredentialsInContainer(containerId, user, home, files)
  }
}

class LinuxHostRuntime implements HostRuntime {
  probeHealth(provider: Provider, ctx: RunContext): Promise<Health> { return probeHealth(provider, ctx) }
  installInContainer(provider: Provider, containerId: string): Promise<void> {
    return installInContainer(provider, containerId)
  }
}

class LinuxPortForwardService implements PortForwardService {
  private readonly fwd = new PortForwarder()
  ensure(containerId: string, port: number, owner: string): Promise<boolean> {
    return this.fwd.ensure(containerId, port, owner)
  }
  release(containerId: string, port: number, owner: string): Promise<void> {
    return this.fwd.release(containerId, port, owner)
  }
  disposeAll(): Promise<void> { return this.fwd.disposeAll() }
  watch(containerId: string, opts: { onForward?: (port: number) => void; owner?: string; intervalMs?: number }): PortWatchHandle {
    return new ContainerPortWatcher(containerId, this.fwd, opts)
  }
}

/** Construct the Linux runtime bundle (the only platform impl in the beta). */
export function createLinuxRuntime(): Runtime {
  return {
    terminal: new LinuxTerminalRuntime(),
    container: new LinuxContainerRuntime(),
    host: new LinuxHostRuntime(),
    ports: new LinuxPortForwardService()
  }
}
