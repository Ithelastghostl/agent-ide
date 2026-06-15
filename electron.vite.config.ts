import { defineConfig } from 'electron-vite'
import { resolve } from 'path'

export default defineConfig({
  main: {
    build: {
      rollupOptions: { external: ['node-pty', 'better-sqlite3'] }
    }
  },
  preload: {
    build: {
      rollupOptions: { external: ['node-pty', 'better-sqlite3'] }
    }
  },
  renderer: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: {
      rollupOptions: { input: resolve('src/renderer/index.html') }
    }
  }
})
