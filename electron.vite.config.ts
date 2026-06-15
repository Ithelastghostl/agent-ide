import { defineConfig } from 'electron-vite'
import { resolve } from 'path'

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: {
      rollupOptions: {
        input: resolve('src/main/index.ts'),
        external: ['node-pty', 'better-sqlite3']
      }
    }
  },
  preload: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: {
      rollupOptions: {
        input: resolve('src/preload/bridge.ts'),
        external: ['node-pty', 'better-sqlite3']
      }
    }
  },
  renderer: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: {
      rollupOptions: { input: resolve('src/renderer/index.html') }
    }
  }
})
