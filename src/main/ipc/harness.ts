import { ipcMain } from 'electron'
import type { IpcDeps } from './deps'
import { readHarness, writeHarness } from '../harness'

/** Harness editor (implemented in P0). */
export function registerHarnessIpc(_deps: IpcDeps): void {
  ipcMain.handle('harness:get', () => readHarness())
  ipcMain.handle('harness:set', (_e, text: unknown) =>
    typeof text === 'string' ? writeHarness(text) : { error: 'invalid text' }
  )
}
