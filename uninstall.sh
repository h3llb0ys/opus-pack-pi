#!/usr/bin/env bash
#
# opus-pack-pi uninstaller
#
# Снимает наши пакеты, чистит наши блоки в settings.json, вырезает
# Opus Pack rules из APPEND_SYSTEM.md. Чужие настройки НЕ трогает.
# Делает .bak бэкап APPEND_SYSTEM.md.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
PI_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
SETTINGS="$PI_DIR/settings.json"
APPEND_SYS="$PI_DIR/APPEND_SYSTEM.md"

c_info=$'\033[0;36m'; c_off=$'\033[0m'
log() { printf "%s[%s]%s %s\n" "$c_info" "$1" "$c_off" "$2"; }

# 1. Снять пакеты
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

# 2. Чистим settings.json
if [ -f "$SETTINGS" ] && command -v jq >/dev/null; then
	TMP="$(mktemp)"
	jq '
		del(.mcpServers.ctm)
		| del(."opus-pack")
		| del(.hooks)
	' "$SETTINGS" > "$TMP" && mv "$TMP" "$SETTINGS"
	log clean "$SETTINGS (mcpServers.ctm, opus-pack, hooks удалены)"
else
	log skip "settings.json (нет файла или нет jq)"
fi

# 3. Вырезаем Opus Pack rules из APPEND_SYSTEM.md
if [ -f "$APPEND_SYS" ] && grep -qF "Opus Pack rules START" "$APPEND_SYS"; then
	cp "$APPEND_SYS" "$APPEND_SYS.bak"
	# sed на BSD/macOS требует расширение для -i; используем -i ''
	sed -i.tmp '/Opus Pack rules START/,/Opus Pack rules END/d' "$APPEND_SYS"
	rm -f "$APPEND_SYS.tmp"
	log clean "$APPEND_SYS (бэкап в .bak)"
else
	log skip "$APPEND_SYS (нет блока Opus Pack rules)"
fi

echo
echo "═══ Opus Pack снесён ═══"
echo "Если хочешь восстановить: ./install.sh"
