#!/usr/bin/env bash
# Update opus-pack-pi и все community-пакеты, ре-merge settings.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "[1/3] pi update (non-pinned пакеты)"
pi update || echo "  (some packages skipped)"

echo "[2/3] git pull в $REPO_DIR"
cd "$REPO_DIR"
if [ -d .git ] && git remote get-url origin >/dev/null 2>&1; then
	git pull --ff-only || echo "  (не удалось fast-forward — есть локальные коммиты или конфликт)"
else
	echo "  (не git-репо или без remote, пропускаю)"
fi

echo "[3/3] re-merge settings.json"
"$REPO_DIR/install.sh"
