#!/usr/bin/env bash
# Launches the Agent IDE. Builds if needed, ensures native modules match
# Electron's ABI (running `npm test` rebuilds them for Node — see RUNNING.md),
# then runs the production app. Used by the desktop entry (agent-ide.desktop).
set -e
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

# Build if there's no prior build, OR if any source is newer than the build.
# (Only rebuilding when out/ is MISSING shipped stale code after every edit —
# the app would run old bundles and look "unfixed". Building is cheap.)
needs_build=false
if [ ! -f out/main/index.js ]; then
  needs_build=true
elif [ -n "$(find src electron.vite.config.ts package.json -type f -newer out/main/index.js 2>/dev/null | head -1)" ]; then
  needs_build=true
fi
if [ "$needs_build" = true ]; then
  npm run build
fi

# Always rebuild node-pty + better-sqlite3 for the Electron ABI before launch.
# This prevents the "blank window" failure when the modules were last built for
# Node (e.g. by `npm test`'s pretest). It's a no-op when already correct.
npm run rebuild:electron >/dev/null 2>&1 || true

exec npx electron-vite preview
