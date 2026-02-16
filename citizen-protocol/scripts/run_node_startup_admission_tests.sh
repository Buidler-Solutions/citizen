#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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

  echo "Unable to find Cargo.toml for citizen startup admission tests." >&2
  echo "Checked: ${candidates[*]}" >&2
  return 1
}

MANIFEST_PATH="$(resolve_manifest_path)"

echo "Using manifest: $MANIFEST_PATH"

if [[ $# -eq 0 ]]; then
  cargo test -p citizen-node admission::startup::tests --manifest-path "$MANIFEST_PATH" -- --nocapture
  exit 0
fi

for test_name in "$@"; do
  echo "Running targeted test: $test_name"
  cargo test -p citizen-node "$test_name" --manifest-path "$MANIFEST_PATH" -- --nocapture
done
