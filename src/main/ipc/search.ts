import { ipcMain } from 'electron'
import type { IpcDeps } from './deps'

/** Cross-session FTS search (implemented in P0, C-9/C-10). */
export function registerSearchIpc({ store }: IpcDeps): void {
  ipcMain.handle('search:query', (_e, query: unknown, limit: unknown) => {
    if (typeof query !== 'string' || !store) return []
    const n = typeof limit === 'number' && limit > 0 && limit <= 200 ? limit : 50
    return store.search(query, n)
  })
}
