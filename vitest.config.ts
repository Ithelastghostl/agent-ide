import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') }
  },
  test: {
    // Per-file environment: renderer component tests opt into jsdom via
    // a `// @vitest-environment jsdom` docblock. Default stays node for
    // main-process and shared logic tests.
    environment: 'node',
    include: ['tests/**/*.test.ts']
  }
})
