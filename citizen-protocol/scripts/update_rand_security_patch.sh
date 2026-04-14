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

  echo "Unable to find Cargo.toml for rand security patch update." >&2
  echo "Checked: ${candidates[*]}" >&2
  return 1
}

MANIFEST_PATH="$(resolve_manifest_path)"
WORKSPACE_DIR="$(cd "$(dirname "$MANIFEST_PATH")" && pwd)"
LOCKFILE_PATH="$WORKSPACE_DIR/Cargo.lock"

if [[ ! -f "$LOCKFILE_PATH" ]]; then
  echo "Cargo.lock not found at $LOCKFILE_PATH" >&2
  exit 1
fi

mapfile -t RAND_VERSIONS < <(python - <<'PY' "$LOCKFILE_PATH"
from pathlib import Path
import sys

lines = Path(sys.argv[1]).read_text().splitlines()
versions = []
for idx, line in enumerate(lines):
    if line.strip() == 'name = "rand"' and idx + 1 < len(lines):
        nxt = lines[idx + 1].strip()
        if nxt.startswith('version = "'):
            versions.append(nxt.split('"')[1])

for v in versions:
    print(v)
PY
)

if [[ " ${RAND_VERSIONS[*]} " == *" 0.9.2 "* ]]; then
  echo "Updating rand 0.9.2 -> 0.9.3 (offline)"
  cargo update -p rand@0.9.2 --precise 0.9.3 --offline --manifest-path "$MANIFEST_PATH"
else
  echo "No rand@0.9.2 package found in lockfile. Current rand entries: ${RAND_VERSIONS[*]}"
  echo "If you need to refresh the patched lock selection, run:"
  echo "  cargo update -p rand@0.9.3 --precise 0.9.3 --offline --manifest-path $MANIFEST_PATH"
fi
