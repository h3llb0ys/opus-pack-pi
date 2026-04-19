#!/usr/bin/env bash
#
# opus-pack-pi installer (idempotent)
#
# - Доустанавливает недостающие community-пакеты через `pi install`
# - Регистрирует локальный путь репо в pi (если ещё не зарегистрирован)
# - Безопасно мерджит settings.json через jq (не перезаписывает чужие ключи)
# - Append APPEND_SYSTEM.md в ~/.pi/agent/APPEND_SYSTEM.md (с маркерами для clean uninstall)
#
# Запускать многократно безопасно — печатает [skip] для уже сделанного.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
PI_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
SETTINGS="$PI_DIR/settings.json"
MCP_JSON="$PI_DIR/mcp.json"
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
	"git:github.com/viartemev/pi-rtk-rewrite"
	"npm:pi-mcp-adapter"
	"git:github.com/tmustier/pi-extensions"
	"git:github.com/MasuRii/pi-tool-display"
	"git:github.com/nicobailon/pi-web-access"
	"git:github.com/viartemev/pi-working-message"
)

# Anthropic-only: proxy for Claude Max subscription. Skipped unless explicitly requested
# or already installed. Pass ANTHROPIC=1 to install.
ANTHROPIC_PKGS=(
	"git:github.com/rynfar/meridian"
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

# 3b. Anthropic-only packages (meridian — Claude Max proxy)
if [ "${ANTHROPIC:-0}" = "1" ]; then
	for pkg in "${ANTHROPIC_PKGS[@]}"; do
		short="${pkg##*/}"
		if grep -qF "$pkg" <<< "$INSTALLED" || grep -qF "$short" <<< "$INSTALLED"; then
			log skip "$pkg"
		else
			log install "$pkg"
			pi install "$pkg" || warn "не удалось установить $pkg (продолжаем)"
		fi
	done
fi

# 4. Local opus-pack-pi
if grep -qF "$REPO_DIR" <<< "$INSTALLED"; then
	log skip "$REPO_DIR (local, уже зарегистрирован)"
else
	log install "$REPO_DIR (local)"
	pi install "$REPO_DIR" || fail "не удалось зарегистрировать локальный путь $REPO_DIR"
fi

# 5. Merge settings.json (без mcpServers — он живёт в mcp.json)
if [ -f "$REPO_DIR/settings.json.example" ]; then
	TMP="$(mktemp)"
	# Drop keys whose name starts with "_" (recursively) so the example's
	# inline comment / placeholder blocks don't end up in the live config.
	# opus-pack deep-merges via jq `*` so user customisations survive
	# re-install (earlier versions did a shallow overwrite which wiped e.g.
	# user-added permissions rules or subagent.modelAlias).
	jq --slurpfile patch "$REPO_DIR/settings.json.example" '
		def drop_underscores:
			if type == "object" then
				with_entries(select(.key | startswith("_") | not))
				| map_values(drop_underscores)
			elif type == "array" then
				map(drop_underscores)
			else .
			end;
		. as $base
		| (.hooks      // {}) as $bh
		| (."opus-pack" // {}) as $bop
		| (.packages   // []) as $bp
		| ($patch[0].hooks      // {} | drop_underscores) as $ph
		| ($patch[0]."opus-pack" // {} | drop_underscores) as $pop
		| ($patch[0].packages   // [] | drop_underscores) as $pp
		| $base
		  + { hooks: ($bh + $ph) }
		  + { "opus-pack": ($pop * $bop) }
		  + { packages: ($bp + (
			    $pp
			    | map(select(. as $p | $bp | map(.source? // (if type=="string" then . else "" end)) | index($p.source? // ($p|tostring)) | not))
		      )) }
	' "$SETTINGS" > "$TMP" && mv "$TMP" "$SETTINGS"
	ok "settings.json смержен"
else
	warn "settings.json.example не найден, пропускаю merge"
fi

# 5b. Merge mcp.json (для pi-mcp-adapter — отдельный файл)
if [ -f "$REPO_DIR/mcp.json.example" ]; then
	[ -f "$MCP_JSON" ] || echo '{}' > "$MCP_JSON"
	TMP="$(mktemp)"
	jq --slurpfile patch "$REPO_DIR/mcp.json.example" '
		. as $base
		| (.mcpServers // {}) as $bs
		| (.settings   // {}) as $bset
		| $base
		  + { settings:   ($bset + (($patch[0].settings   // {}) | with_entries(select(.key != "_comment")))) }
		  + { mcpServers: ($bs   + (($patch[0].mcpServers // {}) | with_entries(select(.key != "_comment"))
		                                                         | map_values(with_entries(select(.key != "_comment"))))) }
	' "$MCP_JSON" > "$TMP" && mv "$TMP" "$MCP_JSON"
	ok "mcp.json смержен (для pi-mcp-adapter): $MCP_JSON"
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

# 8. Final report
printf "\n═══ Opus Pack установлен ═══\n"
echo "Repo:      $REPO_DIR"
echo "Settings:  $SETTINGS"
echo "MCP:       $MCP_JSON"
echo "Append:    $APPEND_SYS"
echo
echo "Запусти 'pi' и /status — увидишь сводку. Footer: ext:N skills:M mcp:K"
