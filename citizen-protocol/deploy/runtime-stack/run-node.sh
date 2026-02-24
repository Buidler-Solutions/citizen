#!/usr/bin/env bash
set -euo pipefail

CONFIG_PATH="${1:-./config/node.toml}"

if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "[run-node] config not found: $CONFIG_PATH" >&2
  exit 1
fi

RUST_LOG="${RUST_LOG:-info}" ./bin/citizen-node "$CONFIG_PATH"
