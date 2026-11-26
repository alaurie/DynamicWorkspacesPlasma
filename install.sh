#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ID="dynamicworkspaces"

if ! command -v kpackagetool6 >/dev/null 2>&1; then
    echo "Error: kpackagetool6 not found. This script requires KDE Plasma 6." >&2
    exit 1
fi

if kpackagetool6 --type KWin/Script --show "$PLUGIN_ID" >/dev/null 2>&1; then
    echo "Upgrading existing $PLUGIN_ID KWin script..."
    kpackagetool6 --type KWin/Script --upgrade "$SCRIPT_DIR"
else
    echo "Installing $PLUGIN_ID KWin script..."
    kpackagetool6 --type KWin/Script --install "$SCRIPT_DIR"
fi

echo ""
echo "Installed '$PLUGIN_ID' successfully!"
echo "Enable it in: System Settings -> Window Management -> KWin Scripts -> Dynamic Workspaces"
echo "Or enable via CLI:"
echo "  kwriteconfig6 --file kwinrc --group Plugins --key ${PLUGIN_ID}Enabled true"
echo "  qdbus6 org.kde.KWin /KWin reconfigure"
