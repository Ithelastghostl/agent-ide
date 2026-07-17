#!/usr/bin/env bash
# Installs "Nacho's IDE.app" into ~/Applications so the IDE launches from
# Finder/Spotlight/Dock. macOS counterpart of install-desktop.sh.
# Run once: bash scripts/install-macos-app.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

APP_DIR="$HOME/Applications/Nacho's IDE.app"
BIN_DIR="$APP_DIR/Contents/MacOS"
RES_DIR="$APP_DIR/Contents/Resources"
mkdir -p "$BIN_DIR" "$RES_DIR"
chmod +x "$HERE/scripts/launch.sh"

cat > "$APP_DIR/Contents/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Nacho's IDE</string>
  <key>CFBundleDisplayName</key><string>Nacho's IDE</string>
  <key>CFBundleIdentifier</key><string>dev.nacho.agent-ide</string>
  <key>CFBundleVersion</key><string>1.0.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>nachos-ide</string>
  <key>CFBundleIconFile</key><string>agent-ide.icns</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
</dict>
</plist>
PLIST

# The launcher runs OUTSIDE any terminal (launchd env), so it must construct
# its own PATH (Codex R2-3: a clean login shell does NOT see ~/.local/bin) and
# surface failures visibly — there is no terminal to read errors from.
cat > "$BIN_DIR/nachos-ide" << LAUNCHER
#!/bin/bash
REPO="$HERE"
LOG_DIR="\$HOME/Library/Logs/nachos-ide"
mkdir -p "\$LOG_DIR"
LOG="\$LOG_DIR/launch.log"

# Deterministic PATH: user-level tool dirs first (provider CLIs, node, docker),
# then the macOS system dirs (Codex R2-11).
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/opt/homebrew/opt/node@24/bin:\$HOME/.local/bin:\$HOME/.orbstack/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

{
  echo "=== launch \$(date) ==="
  "\$REPO/scripts/launch.sh"
} >> "\$LOG" 2>&1
status=\$?
if [ \$status -ne 0 ]; then
  /usr/bin/osascript -e "display alert \"Nacho's IDE failed to launch\" message \"Exit \$status — see \$LOG\"" || true
fi
exit \$status
LAUNCHER
chmod +x "$BIN_DIR/nachos-ide"

# Best-effort icon: SVG → PNG (qlmanage) → iconset (sips) → icns (iconutil).
ICON_OK=false
if command -v qlmanage > /dev/null 2>&1 && command -v iconutil > /dev/null 2>&1; then
  TMP="$(mktemp -d)"
  if qlmanage -t -s 1024 -o "$TMP" "$HERE/assets/icon.svg" > /dev/null 2>&1 \
     && [ -f "$TMP/icon.svg.png" ]; then
    ICONSET="$TMP/agent-ide.iconset"
    mkdir -p "$ICONSET"
    ok=true
    for size in 16 32 64 128 256 512; do
      sips -z $size $size "$TMP/icon.svg.png" --out "$ICONSET/icon_${size}x${size}.png" > /dev/null 2>&1 || ok=false
      sips -z $((size * 2)) $((size * 2)) "$TMP/icon.svg.png" --out "$ICONSET/icon_${size}x${size}@2x.png" > /dev/null 2>&1 || ok=false
    done
    if [ "$ok" = true ] && iconutil -c icns "$ICONSET" -o "$RES_DIR/agent-ide.icns" > /dev/null 2>&1; then
      ICON_OK=true
    fi
  fi
  rm -rf "$TMP"
fi
[ "$ICON_OK" = true ] || echo "note: icon conversion skipped (app works, generic icon)"

# Let LaunchServices notice the (new) bundle.
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP_DIR" > /dev/null 2>&1 || true

echo "Installed -> $APP_DIR"
echo "Launch from Finder/Spotlight as \"Nacho's IDE\". Logs: ~/Library/Logs/nachos-ide/launch.log"
