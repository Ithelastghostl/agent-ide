#!/usr/bin/env bash
# Launches the Agent IDE. Builds first if needed, then runs the production app.
# Used by the desktop entry (agent-ide.desktop).
set -e
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

# Build once if there's no prior build.
if [ ! -f out/main/index.js ]; then
  npm run build
fi

exec npx electron-vite preview
