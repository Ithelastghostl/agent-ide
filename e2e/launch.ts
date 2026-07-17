import { join } from 'path'

/** Electron launch args shared by every spec: app dir + sandbox off, plus the
 *  Linux-only Wayland/Vulkan workaround flag (see src/main/index.ts). */
export function electronArgs(): string[] {
  const ozone = process.platform === 'linux' ? ['--ozone-platform=x11'] : []
  return [join(__dirname, '..'), '--no-sandbox', ...ozone]
}

/** e2e environment (R3-4/R6-2/R7): prepend the inert provider shims to PATH so a
 *  provider launch can never reach a real authenticated CLI, and set
 *  AGENT_IDE_E2E=1 so the launcher refuses container sessions. Merge over
 *  whatever env the spec already sets (temp DB/HISTORY/LIBRARY/HARNESS dirs). */
export function e2eEnv(extra: Record<string, string> = {}): Record<string, string> {
  const shims = join(__dirname, 'fixtures', 'provider-shims')
  return {
    ...process.env as Record<string, string>,
    AGENT_IDE_E2E: '1',
    PATH: `${shims}:${process.env.PATH ?? ''}`,
    ...extra
  }
}
