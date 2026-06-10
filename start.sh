#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

if [[ -z "$NODE_BIN" ]]; then
  echo "找不到 node，請先安裝 Node.js 20+。"
  exit 1
fi

echo "正在啟動訂閱帳務管理系統..."
echo "----------------------------------------"
exec "$NODE_BIN" "$SCRIPT_DIR/server.cjs"
