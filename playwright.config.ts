import { defineConfig } from '@playwright/test'

// Electron integration tests. Require a display (real or Xvfb):
//   xvfb-run -a npm run e2e
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list'
})
