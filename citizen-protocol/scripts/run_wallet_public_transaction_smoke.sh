#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

pushd "${ROOT_DIR}" >/dev/null
cargo test -p citizen-wallet tests::signs_and_verifies_entry -- --exact --nocapture
popd >/dev/null

echo "public wallet transaction smoke passed"
