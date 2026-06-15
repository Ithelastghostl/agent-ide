#!/usr/bin/env bash
# Installs the Agent IDE launcher into the user's application menu.
# Run once: bash scripts/install-desktop.sh
set -e
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

LAUNCH="$HERE/scripts/launch.sh"
ICON="$HERE/assets/icon.svg"
APPS_DIR="$HOME/.local/share/applications"
DEST="$APPS_DIR/agent-ide.desktop"

chmod +x "$HERE/scripts/launch.sh"
mkdir -p "$APPS_DIR"

sed -e "s|__LAUNCH__|$LAUNCH|g" -e "s|__ICON__|$ICON|g" \
  "$HERE/assets/agent-ide.desktop.template" > "$DEST"
chmod +x "$DEST"

# Refresh the desktop database if the tool is available.
command -v update-desktop-database >/dev/null 2>&1 && \
  update-desktop-database "$APPS_DIR" 2>/dev/null || true

echo "Installed launcher -> $DEST"
echo "Agent IDE should now appear in your application menu."
