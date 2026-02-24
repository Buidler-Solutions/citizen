#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

pushd "${ROOT_DIR}" >/dev/null
cargo test -p citizen-wallet tests::signs_and_decrypts_hybrid_private_entry -- --exact
popd >/dev/null

echo "hybrid whole-payload ACL wallet smoke passed"
