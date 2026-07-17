import { join } from 'path'

/** Electron launch args shared by every spec: app dir + sandbox off, plus the
 *  Linux-only Wayland/Vulkan workaround flag (see src/main/index.ts). */
export function electronArgs(): string[] {
  const ozone = process.platform === 'linux' ? ['--ozone-platform=x11'] : []
  return [join(__dirname, '..'), '--no-sandbox', ...ozone]
}
