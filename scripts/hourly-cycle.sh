#!/bin/zsh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/Library/Caches/ms-playwright}"
export HH_HEADLESS="${HH_HEADLESS:-1}"
cd "$ROOT"
exec /opt/homebrew/bin/node "$ROOT/scripts/hourly-cycle.mjs"
