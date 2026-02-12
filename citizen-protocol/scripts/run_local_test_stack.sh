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

mkdir -p data

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

sleep 2

echo "[stack] starting explorer backend"
(
  cd explorer/backend
  PORT=4010 CITIZEN_NODE_URL=http://127.0.0.1:8081 npm run start:dev
) > data/explorer-backend-stack.log 2>&1 &
EXPLORER_BACKEND_PID=$!

sleep 2

echo "[stack] starting explorer frontend"
(
  cd explorer/frontend
  NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:4010 npm run dev -- --port 4020
) > data/explorer-frontend-stack.log 2>&1 &
EXPLORER_FRONTEND_PID=$!

pids=(
  "$LOCALNET_PID"
  "$DEMO_PID"
  "$WALLET_PID"
  "$EXPLORER_BACKEND_PID"
  "$EXPLORER_FRONTEND_PID"
)

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
echo "  - data/explorer-backend-stack.log"
echo "  - data/explorer-frontend-stack.log"
echo "[stack] demo blog: http://localhost:4300"
echo "[stack] explorer backend: http://127.0.0.1:4010"
echo "[stack] explorer frontend: http://127.0.0.1:4020"
echo "[stack] load extension from wallet/browser/dist"

wait
