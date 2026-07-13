#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
export DATA_DIR="${DATA_DIR:-$SCRIPT_DIR}"

if command -v pnpm >/dev/null 2>&1; then
  exec pnpm run start
fi

if command -v corepack >/dev/null 2>&1; then
  exec corepack pnpm run start
fi

echo "找不到 pnpm，請先安裝 pnpm 11+ 或啟用 Corepack。"
exit 1
