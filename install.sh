#!/usr/bin/env bash
#
# opus-pack-pi installer (idempotent)
#
# - Installs any missing community packages via `pi install`
# - Registers the local repo path with pi (if not already registered)
# - Deep-merges settings.json through jq (preserves unrelated keys)
# - Appends APPEND_SYSTEM.md to ~/.pi/agent/APPEND_SYSTEM.md (with markers for clean uninstall)
#
# Safe to re-run — prints [skip] for anything already in place.

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
command -v pi >/dev/null || fail "pi is not installed. See https://pi.dev"
command -v jq >/dev/null || fail "jq is required for safe settings.json merging. brew install jq / apt install jq"
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
	# Subagent orchestration (replaces the previously-bundled extensions/subagent/).
	"git:github.com/nicobailon/pi-subagents"
	# Static code-quality pipeline on every write/edit: LSP, linters, formatters,
	# tree-sitter rules, secrets scanning.
	"git:github.com/apmantza/pi-lens"
	# Hash-anchored read/grep/edit. Every line carries a LINE#HASH prefix so
	# edits reference anchors instead of raw text — no "string not found", no
	# ambiguous matches, stale reads fail hard. Ported from oh-my-pi.
	"git:github.com/RimuruW/pi-hashline-edit"
	# /btw — parallel side-conversation sub-session. Ask clarifying questions
	# or explore tangents without derailing the main agent turn; inject the
	# result back when ready. Alt+/ to toggle focus.
	"git:github.com/dbachelder/pi-btw"
	# ask_user tool with searchable options, multi-select, freeform input,
	# overlay mode, and a bundled decision-gating skill. Replaces our
	# homegrown extensions/ask-user.ts.
	"git:github.com/edlsh/pi-ask-user"
	# Scans git diffs on `git commit` / `git push` for 30+ secret patterns
	# (AWS/Azure/GCP/GitHub tokens, JWT, private keys, password assignments)
	# + agent-powered review for suspicious cases. Third defense-in-depth
	# layer alongside safe-deny (path) and pi-lens (write content).
	"git:github.com/acarerdinc/pi-secret-guard"
)

# Anthropic-only: Claude Max subscription proxy. Skipped unless explicitly requested
# or already installed. Set ANTHROPIC=1 to install.
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
		pi install "$pkg" || warn "failed to install $pkg (continuing)"
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
			pi install "$pkg" || warn "failed to install $pkg (continuing)"
		fi
	done
fi

# 4. Local opus-pack-pi
if grep -qF "$REPO_DIR" <<< "$INSTALLED"; then
	log skip "$REPO_DIR (local, already registered)"
else
	log install "$REPO_DIR (local)"
	pi install "$REPO_DIR" || fail "failed to register local repo path $REPO_DIR"
fi

# 5. Merge settings.json (mcpServers lives in mcp.json)
if [ -f "$REPO_DIR/settings.json.example" ]; then
	TMP="$(mktemp)"
	# Drop keys whose name starts with "_" (recursively) so the example's
	# inline comment / placeholder blocks don't end up in the live config.
	# opus-pack deep-merges via jq `*` so user customisations survive
	# re-install (earlier versions did a shallow overwrite which wiped e.g.
	# user-added permissions rules or router levels).
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
	ok "settings.json merged"
else
	warn "settings.json.example not found, skipping merge"
fi

# 5b. Merge mcp.json (read by pi-mcp-adapter — separate file)
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
	ok "mcp.json merged (for pi-mcp-adapter): $MCP_JSON"
fi

# 6. APPEND_SYSTEM.md
if [ -f "$APPEND_SYS" ] && grep -qF "Opus Pack rules START" "$APPEND_SYS"; then
	log skip "$APPEND_SYS already contains Opus Pack rules"
else
	[ -f "$APPEND_SYS" ] && printf "\n" >> "$APPEND_SYS"
	cat "$REPO_DIR/APPEND_SYSTEM.md" >> "$APPEND_SYS"
	ok "$APPEND_SYS updated"
fi

# 7. Runtime dependencies for extensions
if [ ! -d "$REPO_DIR/node_modules/minimatch" ]; then
    echo "[install] Installing runtime dependencies..."
    (cd "$REPO_DIR" && npm install --omit=dev) 2>/dev/null || warn "npm install failed — permissions extension may not load"
fi

# 7b. Agent profiles. pi-subagents discovers agents from ~/.pi/agent/agents/
#     (user scope, overrides its own bundled roster). Copy each bundled .md
#     with cp -n so user edits survive re-runs; never clobber.
AGENTS_SRC="$REPO_DIR/agents"
AGENTS_DST="$PI_DIR/agents"
if [ -d "$AGENTS_SRC" ]; then
	mkdir -p "$AGENTS_DST"
	for src in "$AGENTS_SRC"/*.md; do
		[ -f "$src" ] || continue
		name="$(basename "$src")"
		dst="$AGENTS_DST/$name"
		if [ -f "$dst" ]; then
			log skip "agent $name (already in $AGENTS_DST)"
		else
			cp "$src" "$dst"
			ok "agent $name → $AGENTS_DST"
		fi
	done
fi

# 8. lean-ctx (token-optimising shell/read layer). Installs a single Rust
#    binary. Skip entirely with OPUS_PACK_SKIP_LEAN_CTX=1. Tries brew, then
#    cargo, then the upstream install script, then gives up with a warning
#    (the pack still works without it).
if [ "${OPUS_PACK_SKIP_LEAN_CTX:-0}" = "1" ]; then
	log skip "lean-ctx (OPUS_PACK_SKIP_LEAN_CTX=1)"
elif command -v lean-ctx >/dev/null 2>&1; then
	log skip "lean-ctx (already on PATH)"
else
	log install "lean-ctx"
	installed=0
	if command -v brew >/dev/null 2>&1; then
		brew tap yvgude/lean-ctx >/dev/null 2>&1 \
			&& brew install lean-ctx >/dev/null 2>&1 \
			&& installed=1
	fi
	if [ "$installed" = "0" ] && command -v cargo >/dev/null 2>&1; then
		cargo install lean-ctx >/dev/null 2>&1 && installed=1
	fi
	if [ "$installed" = "0" ]; then
		curl -fsSL https://leanctx.com/install.sh | sh >/dev/null 2>&1 && installed=1
	fi
	if [ "$installed" = "1" ] && command -v lean-ctx >/dev/null 2>&1; then
		ok "lean-ctx installed"
		# One-time editor/shell wiring. Non-fatal if it fails — user can re-run.
		lean-ctx setup >/dev/null 2>&1 || warn "lean-ctx setup failed; run 'lean-ctx setup' manually"
	else
		warn "lean-ctx install failed (tried brew / cargo / curl). See https://github.com/yvgude/lean-ctx"
	fi
fi

# 9. Final report
printf "\n═══ Opus Pack installed ═══\n"
echo "Repo:      $REPO_DIR"
echo "Settings:  $SETTINGS"
echo "MCP:       $MCP_JSON"
echo "Append:    $APPEND_SYS"
echo
echo "Run 'pi' and /status to see the summary. Footer: ext:N skills:M mcp:K"
