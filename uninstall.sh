#!/usr/bin/env bash
#
# opus-pack-pi uninstaller
#
# Removes pack-installed packages, cleans our blocks out of settings.json, and strips
# Removes the Opus Pack rules block from APPEND_SYSTEM.md. Never touches unrelated settings.
# the Opus Pack rules block from APPEND_SYSTEM.md. Creates a .bak backup.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
PI_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
SETTINGS="$PI_DIR/settings.json"
APPEND_SYS="$PI_DIR/APPEND_SYSTEM.md"

c_info=$'\033[0;36m'; c_off=$'\033[0m'
log() { printf "%s[%s]%s %s\n" "$c_info" "$1" "$c_off" "$2"; }

# 1. Remove packages
PACKAGES=(
	"git:github.com/obra/superpowers"
	"git:github.com/rynfar/meridian"
	"git:github.com/viartemev/pi-rtk-rewrite"
	"npm:pi-mcp-adapter"
	"git:github.com/tmustier/pi-extensions"
	"git:github.com/MasuRii/pi-tool-display"
	"git:github.com/nicobailon/pi-web-access"
	"git:github.com/viartemev/pi-working-message"
)
for pkg in "${PACKAGES[@]}"; do
	log remove "$pkg"
	pi remove "$pkg" 2>/dev/null || true
done
log remove "$REPO_DIR (local)"
pi remove "$REPO_DIR" 2>/dev/null || true

# 2. Clean settings.json
if [ -f "$SETTINGS" ] && command -v jq >/dev/null; then
	TMP="$(mktemp)"
	jq '
		del(."opus-pack")
		| del(.hooks)
	' "$SETTINGS" > "$TMP" && mv "$TMP" "$SETTINGS"
	log clean "$SETTINGS (opus-pack, hooks removed)"
else
	log skip "settings.json (missing file or jq)"
fi

# 3. Strip Opus Pack rules from APPEND_SYSTEM.md
if [ -f "$APPEND_SYS" ] && grep -qF "Opus Pack rules START" "$APPEND_SYS"; then
	cp "$APPEND_SYS" "$APPEND_SYS.bak"
	# sed on BSD/macOS requires an extension argument for -i; use -i.tmp
	sed -i.tmp '/Opus Pack rules START/,/Opus Pack rules END/d' "$APPEND_SYS"
	rm -f "$APPEND_SYS.tmp"
	log clean "$APPEND_SYS (backup in .bak)"
else
	log skip "$APPEND_SYS (no Opus Pack rules block)"
fi

echo
echo "═══ Opus Pack uninstalled ═══"
echo "To reinstall: ./install.sh"
