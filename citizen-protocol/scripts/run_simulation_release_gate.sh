#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

DURATION_SECS="${DURATION_SECS:-10}"
OUT_DIR="${OUT_DIR:-reports/releases}"

cd "${REPO_ROOT}"

echo "[simulation-release-gate] Running Section 19 matrix (50/75/100 validators x all scenarios)"
cargo run -p citizen-simulation --bin run -- \
  --matrix \
  --duration-secs "${DURATION_SECS}" \
  --out-dir "${OUT_DIR}"

echo "[simulation-release-gate] Complete. Matrix report written under ${OUT_DIR}"
