import type { Runtime } from './types'
import { createLinuxRuntime } from './linux'

export type {
  Runtime,
  TerminalRuntime,
  ContainerRuntime,
  HostRuntime,
  PortForwardService,
  PortWatchHandle
} from './types'

/** Select the platform runtime. Linux is the only implementation in the beta;
 *  Windows (M2 — Win32HostRuntime/ConPTY) and macOS (M3* — DarwinHostRuntime) plug
 *  in here later behind the same interfaces. node-pty works on all three, so only
 *  the host/container/PATH specifics differ per platform. */
export function createRuntime(): Runtime {
  switch (process.platform) {
    case 'linux':
      return createLinuxRuntime()
    // case 'win32': return createWin32Runtime()   // M2
    // case 'darwin': return createDarwinRuntime()  // M3*
    default:
      // node-pty + docker CLI behave like Linux on macOS today; until a dedicated
      // Darwin/Win runtime exists, fall back to the Linux impl rather than crash.
      return createLinuxRuntime()
  }
}
