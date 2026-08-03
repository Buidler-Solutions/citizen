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

mkdir -p data/triolet-alpha data/triolet-beta data/triolet-gamma

if [[ ! -f config/localnet/certs/ca.der ]]; then
  echo "[triolet] generating QUIC certs"
  scripts/generate_localnet_quic_certs.sh
fi

configs=(
  "config/triolet/validator-alpha.toml"
  "config/triolet/validator-beta.toml"
  "config/triolet/validator-gamma.toml"
)

api_ports=()
for cfg in "${configs[@]}"; do
  port="$(awk -F'= ' '/^api_port/ { gsub(/ /, "", $2); print $2; exit }' "$cfg")"
  if [[ -z "$port" ]]; then
    echo "failed to read api_port from ${cfg}" >&2; exit 1
  fi
  api_ports+=("$port")
done

echo "[triolet] building citizen-node binary"
cargo build -p citizen-node >/dev/null
node_bin="$ROOT_DIR/target/debug/citizen-node"

if [[ ! -x "$node_bin" ]]; then
  echo "binary not found: ${node_bin}" >&2; exit 1
fi

pids=()
for i in "${!configs[@]}"; do
  cfg="${configs[$i]}"
  port="${api_ports[$i]}"
  name="$(basename "$cfg" .toml)"
  log_file="data/${name}.log"
  echo "[triolet] starting ${name} on http://127.0.0.1:${port} (logs → ${log_file})"
  RUST_LOG=info "$node_bin" "$cfg" >"${log_file}" 2>&1 &
  pids+=("$!")
done

cleanup() {
  echo "[triolet] shutting down nodes"
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup SIGINT SIGTERM

for i in "${!api_ports[@]}"; do
  port="${api_ports[$i]}"
  name="$(basename "${configs[$i]}" .toml)"
  ready=0
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
      ready=1; break
    fi
    sleep 1
  done
  if [[ "$ready" -ne 1 ]]; then
    echo "[triolet] ${name} failed health checks on http://127.0.0.1:${port}/health" >&2
    tail -n 80 "${ROOT_DIR}/data/${name}.log" >&2 || true
    cleanup; exit 1
  fi
done

echo "[triolet] all 3 nodes healthy. Quorum: 3/3 (BFT >2/3 of 3). Press Ctrl+C to stop."
echo "[triolet] try: curl http://127.0.0.1:${api_ports[0]}/health"
wait
