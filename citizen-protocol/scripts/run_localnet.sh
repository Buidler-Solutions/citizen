#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo is required to launch the localnet" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to probe localnet health endpoints" >&2
  exit 1
fi

mkdir -p data/alpha data/beta data/gamma data/delta data/epsilon

echo "[localnet] generating fresh shared QUIC CA/certs"
scripts/generate_localnet_quic_certs.sh --fresh

configs=(
  "config/localnet/validator-alpha.toml"
  "config/localnet/validator-beta.toml"
  "config/localnet/validator-gamma.toml"
  "config/localnet/validator-delta.toml"
  "config/localnet/validator-epsilon.toml"
)

api_ports=()
for cfg in "${configs[@]}"; do
  port="$(awk -F'= ' '/^api_port/ { gsub(/ /, "", $2); print $2; exit }' "$cfg")"
  if [[ -z "$port" ]]; then
    echo "failed to read api_port from ${cfg}" >&2
    exit 1
  fi
  api_ports+=("$port")
done

echo "[localnet] building citizen-node binary once (avoids cargo lock contention)"
cargo build -p citizen-node >/dev/null
node_bin="$ROOT_DIR/target/debug/citizen-node"

if [[ ! -x "$node_bin" ]]; then
  echo "expected binary not found: ${node_bin}" >&2
  exit 1
fi

pids=()
for i in "${!configs[@]}"; do
  cfg="${configs[$i]}"
  port="${api_ports[$i]}"
  name="$(basename "$cfg" .toml)"
  log_file="data/${name}.log"
  echo "[localnet] starting ${name} on http://127.0.0.1:${port} (logs -> ${log_file})"
  RUST_LOG=info "$node_bin" "$cfg" >"${log_file}" 2>&1 &
  pids+=("$!")
done

cleanup() {
  echo "[localnet] shutting down nodes"
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
}

trap cleanup SIGINT SIGTERM

startup_deadline_secs=30
for i in "${!api_ports[@]}"; do
  port="${api_ports[$i]}"
  name="$(basename "${configs[$i]}" .toml)"
  ready=0
  for _ in $(seq 1 "$startup_deadline_secs"); do
    if curl -fsS "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done

  if [[ "$ready" -ne 1 ]]; then
    echo "[localnet] ${name} failed health checks on http://127.0.0.1:${port}/health" >&2
    echo "[localnet] tailing log: ${ROOT_DIR}/data/${name}.log" >&2
    tail -n 80 "${ROOT_DIR}/data/${name}.log" >&2 || true
    cleanup
    exit 1
  fi

done

echo "[localnet] all nodes healthy. Press Ctrl+C to stop."
echo "[localnet] try: curl http://127.0.0.1:${api_ports[0]}/health"
echo "[localnet] note: /health is process liveness only; run scripts/check_localnet_replication_finality.sh to validate QUIC replication/finality"
wait
