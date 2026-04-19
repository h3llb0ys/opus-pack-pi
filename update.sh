#!/usr/bin/env bash
# Update opus-pack-pi plus community packages, re-merge settings.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "[1/3] pi update (non-pinned packages)"
pi update || echo "  (some packages skipped)"

echo "[2/3] git pull in $REPO_DIR"
cd "$REPO_DIR"
if [ -d .git ] && git remote get-url origin >/dev/null 2>&1; then
	git pull --ff-only || echo "  (fast-forward failed — local commits or conflict)"
else
	echo "  (not a git repo or no remote, skipping)"
fi

echo "[3/3] re-merge settings.json"
"$REPO_DIR/install.sh"
