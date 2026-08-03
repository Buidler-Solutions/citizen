#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo is required" >&2; exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required" >&2; exit 1
fi

CFG="config/solo/validator-solo.toml"
PORT="$(awk -F'= ' '/^api_port/ { gsub(/ /, "", $2); print $2; exit }' "$CFG")"

mkdir -p data/solo

if [[ ! -f config/localnet/certs/ca.der ]]; then
  echo "[solo] generating QUIC certs"
  scripts/generate_localnet_quic_certs.sh
fi

echo "[solo] building citizen-node binary"
cargo build -p citizen-node >/dev/null
node_bin="$ROOT_DIR/target/debug/citizen-node"

if [[ ! -x "$node_bin" ]]; then
  echo "binary not found: ${node_bin}" >&2; exit 1
fi

echo "[solo] starting single validator on http://127.0.0.1:${PORT} (logs → data/solo.log)"
RUST_LOG=info "$node_bin" "$CFG" >data/solo.log 2>&1 &
pid=$!

cleanup() {
  echo "[solo] shutting down"
  kill "$pid" 2>/dev/null || true
}
trap cleanup SIGINT SIGTERM

for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    echo "[solo] node healthy. Press Ctrl+C to stop."
    echo "[solo] try: curl http://127.0.0.1:${PORT}/health"
    wait "$pid"
    exit 0
  fi
  sleep 1
done

echo "[solo] node failed health checks" >&2
tail -n 80 data/solo.log >&2 || true
cleanup
exit 1
