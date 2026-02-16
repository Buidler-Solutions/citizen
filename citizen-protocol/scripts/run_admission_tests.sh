#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Support both repository layouts:
# 1) repo-root/citizen-protocol/Cargo.toml (this workspace layout)
# 2) repo-root/Cargo.toml (direct citizen-protocol repo layout)
resolve_manifest_path() {
  local candidates=(
    "$SCRIPT_DIR/../Cargo.toml"
    "$SCRIPT_DIR/../../Cargo.toml"
    "$PWD/Cargo.toml"
    "$PWD/citizen-protocol/Cargo.toml"
  )

  for candidate in "${candidates[@]}"; do
    if [[ -f "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
  done

  echo "Unable to find Cargo.toml for citizen admission tests." >&2
  echo "Checked: ${candidates[*]}" >&2
  return 1
}

MANIFEST_PATH="$(resolve_manifest_path)"

echo "Using manifest: $MANIFEST_PATH"

cargo test -p citizen-node admission::manifest::tests --manifest-path "$MANIFEST_PATH"
cargo test -p citizen-node admission::startup::tests --manifest-path "$MANIFEST_PATH"
cargo test -p citizen-network --test admission --manifest-path "$MANIFEST_PATH"
