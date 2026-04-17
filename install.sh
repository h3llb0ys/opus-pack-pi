#!/usr/bin/env bash
#
# opus-pack-pi installer (idempotent)
#
# - Доустанавливает недостающие community-пакеты через `pi install`
# - Регистрирует локальный путь репо в pi (если ещё не зарегистрирован)
# - Безопасно мерджит settings.json через jq (не перезаписывает чужие ключи)
# - Append APPEND_SYSTEM.md в ~/.pi/agent/APPEND_SYSTEM.md (с маркерами для clean uninstall)
# - Проверяет что claude-total-memory MCP-сервер доступен
#
# Запускать многократно безопасно — печатает [skip] для уже сделанного.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
PI_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
SETTINGS="$PI_DIR/settings.json"
APPEND_SYS="$PI_DIR/APPEND_SYSTEM.md"

c_info=$'\033[0;36m'; c_ok=$'\033[0;32m'; c_warn=$'\033[0;33m'; c_err=$'\033[0;31m'; c_off=$'\033[0m'
log()  { printf "%s[%s]%s %s\n" "$c_info" "$1" "$c_off" "$2"; }
ok()   { printf "%s[ok]%s %s\n" "$c_ok" "$c_off" "$1"; }
warn() { printf "%s[warn]%s %s\n" "$c_warn" "$c_off" "$1"; }
fail() { printf "%s[error]%s %s\n" "$c_err" "$c_off" "$1" >&2; exit 1; }

# 1. Sanity checks
command -v pi >/dev/null || fail "pi не установлен. См. https://pi.dev"
command -v jq >/dev/null || fail "jq нужен для безопасного merge settings.json. brew install jq / apt install jq"
mkdir -p "$PI_DIR"

# 2. settings.json bootstrap
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
ok "settings.json: $SETTINGS"

# 3. Community packages
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

INSTALLED="$(pi list 2>/dev/null || true)"
for pkg in "${PACKAGES[@]}"; do
	short="${pkg##*/}"
	if grep -qF "$pkg" <<< "$INSTALLED" || grep -qF "$short" <<< "$INSTALLED"; then
		log skip "$pkg"
	else
		log install "$pkg"
		pi install "$pkg" || warn "не удалось установить $pkg (продолжаем)"
	fi
done

# 4. Local opus-pack-pi
if grep -qF "$REPO_DIR" <<< "$INSTALLED"; then
	log skip "$REPO_DIR (local, уже зарегистрирован)"
else
	log install "$REPO_DIR (local)"
	pi install "$REPO_DIR" || fail "не удалось зарегистрировать локальный путь $REPO_DIR"
fi

# 5. Merge settings.json
if [ -f "$REPO_DIR/settings.json.example" ]; then
	TMP="$(mktemp)"
	jq --slurpfile patch "$REPO_DIR/settings.json.example" '
		. as $base
		| (.mcpServers // {}) as $bm
		| (.hooks      // {}) as $bh
		| (.packages   // []) as $bp
		| $base
		  + { mcpServers: ($bm + (($patch[0].mcpServers // {}) | with_entries(select(.key != "_comment")))) }
		  + { hooks:      ($bh + (($patch[0].hooks      // {}) | with_entries(select(.key != "_comment")))) }
		  + { "opus-pack": (($patch[0]."opus-pack" // {}) | with_entries(select(.key != "_comment"))) }
		  + { packages:   ($bp + (
			    ($patch[0].packages // [])
			    | map(select(. as $p | $bp | map(.source? // (if type=="string" then . else "" end)) | index($p.source? // ($p|tostring)) | not))
		      )) }
	' "$SETTINGS" > "$TMP" && mv "$TMP" "$SETTINGS"
	ok "settings.json смержен"
else
	warn "settings.json.example не найден, пропускаю merge"
fi

# 6. APPEND_SYSTEM.md
if [ -f "$APPEND_SYS" ] && grep -qF "Opus Pack rules START" "$APPEND_SYS"; then
	log skip "$APPEND_SYS уже содержит Opus Pack rules"
else
	[ -f "$APPEND_SYS" ] && printf "\n" >> "$APPEND_SYS"
	cat "$REPO_DIR/APPEND_SYSTEM.md" >> "$APPEND_SYS"
	ok "$APPEND_SYS дописан"
fi

# 7. Runtime dependencies for extensions
if [ ! -d "$REPO_DIR/node_modules/minimatch" ]; then
    echo "[install] Installing runtime dependencies..."
    (cd "$REPO_DIR" && npm install --omit=dev) 2>/dev/null || warn "npm install failed — permissions extension may not load"
fi

# 8. claude-total-memory health check
CTM_BIN="$HOME/extra/mcp/claude-total-memory/.venv/bin/claude-total-memory"
if [ -x "$CTM_BIN" ]; then
	ok "claude-total-memory MCP server найден: $CTM_BIN"
else
	warn "claude-total-memory не найден по $CTM_BIN — MCP tools будут недоступны"
	echo "       fix: cd ~/extra/mcp/claude-total-memory && uv pip install -e ."
fi

# 9. Final report
printf "\n═══ Opus Pack установлен ═══\n"
echo "Repo:      $REPO_DIR"
echo "Settings:  $SETTINGS"
echo "Append:    $APPEND_SYS"
echo
echo "Запусти 'pi' и /status — увидишь сводку. Footer: ext:N skills:M mcp:K"
