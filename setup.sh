#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if command -v pnpm >/dev/null 2>&1; then
  PM="pnpm"
elif command -v corepack >/dev/null 2>&1; then
  corepack enable
  PM="pnpm"
else
  PM="npm"
fi

echo "Installing dependencies with $PM..."
"$PM" install

echo "Building frontend..."
"$PM" run build

echo "Running health check..."
"$PM" run doctor

if [[ "${1:-}" == "--launchd" ]]; then
  echo "Installing macOS LaunchAgent..."
  "$PM" run launchd:install
fi

echo "Setup complete. Start with: $PM run start"
