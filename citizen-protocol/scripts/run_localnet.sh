#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo is required to launch the localnet" >&2
  exit 1
fi

mkdir -p data/alpha data/beta data/gamma

configs=(
  "config/localnet/validator-alpha.toml"
  "config/localnet/validator-beta.toml"
  "config/localnet/validator-gamma.toml"
)

pids=()
for cfg in "${configs[@]}"; do
  name="$(basename "$cfg" .toml)"
  log_file="data/${name}.log"
  echo "[localnet] starting ${name} (logs -> ${log_file})"
  RUST_LOG=info cargo run -p citizen-node -- "$cfg" >"${log_file}" 2>&1 &
  pids+=("$!")
done

echo "[localnet] nodes running. Press Ctrl+C to stop."

cleanup() {
  echo "[localnet] shutting down nodes"
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
}

trap cleanup SIGINT SIGTERM
wait
