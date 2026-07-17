// Launches electron-vite (dev/preview) or the native-gate with the platform's
// required flags. The ozone flag is the Linux Wayland/Vulkan workaround (see
// src/main/index.ts) and must not be passed on other platforms.
const { spawnSync } = require('node:child_process')

const ozone = process.platform === 'linux' ? ['--ozone-platform=x11'] : []
const mode = process.argv[2]

let bin
let args
if (mode === 'native-gate') {
  bin = 'electron'
  args = ['scripts/native-gate.js', '--no-sandbox', ...ozone]
} else if (mode === 'dev' || mode === 'preview') {
  bin = 'electron-vite'
  args = [mode, ...(ozone.length ? ['--', ...ozone] : [])]
} else {
  console.error(`usage: run-electron.js dev|preview|native-gate (got: ${mode})`)
  process.exit(2)
}

const r = spawnSync('npx', ['--no-install', bin, ...args], { stdio: 'inherit' })
process.exit(r.status ?? 1)
