#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[stack] missing required command: $1" >&2
    exit 1
  fi
}

require_cmd cargo
require_cmd npm

echo "[stack] starting Citizen localnet"
./scripts/run_localnet.sh > data/localnet-stack.log 2>&1 &
LOCALNET_PID=$!

sleep 2

echo "[stack] starting demo blog server"
(
  cd demo
  npm run start
) > data/demo-stack.log 2>&1 &
DEMO_PID=$!

sleep 2

echo "[stack] starting wallet browser watch build"
(
  cd wallet/browser
  npm run build -- --watch
) > data/wallet-stack.log 2>&1 &
WALLET_PID=$!

pids=("$LOCALNET_PID" "$DEMO_PID" "$WALLET_PID")

cleanup() {
  echo "[stack] shutting down processes"
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
}

trap cleanup SIGINT SIGTERM EXIT

echo "[stack] all processes launched"
echo "[stack] logs:"
echo "  - data/localnet-stack.log"
echo "  - data/demo-stack.log"
echo "  - data/wallet-stack.log"
echo "[stack] open http://localhost:4300 and load extension from wallet/browser/dist"

wait
