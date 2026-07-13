#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
export DATA_DIR="${DATA_DIR:-$SCRIPT_DIR}"

if ! command -v pnpm >/dev/null 2>&1; then
  if ! command -v corepack >/dev/null 2>&1; then
    echo "找不到 pnpm，請先安裝 pnpm 11+ 或啟用 Corepack。"
    exit 1
  fi
  corepack enable
fi

echo "Installing dependencies with pnpm..."
pnpm install

echo "Building frontend..."
pnpm run build

echo "Running health check..."
pnpm run doctor

if [[ "${1:-}" == "--launchd" ]]; then
  echo "Installing macOS LaunchAgent..."
  pnpm run launchd:install
fi

echo "Setup complete. Start with: ./start.sh"
