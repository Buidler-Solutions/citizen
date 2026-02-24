#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

pushd "${ROOT_DIR}" >/dev/null
cargo test -p citizen-wallet tests::hybrid_selective_entry_supports_field_reader_acls -- --exact --nocapture
popd >/dev/null


echo "hybrid per-field ACL wallet smoke passed"
