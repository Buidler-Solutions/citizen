#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

pushd "${ROOT_DIR}" >/dev/null

echo "[1/3] Ledger policy regression (no RocksDB build path)"
cargo test -p citizen-ledger enforces_asset_trustline_capacity_release_and_clawback_controls

echo "[2/3] Wallet disclosure rendering parity"
npm --prefix wallet/react test -- --run

echo "[3/3] Explorer disclosure surface parity"
(cd explorer/frontend && npx tsc --noEmit)

popd >/dev/null

echo "Builder-issued asset parity checks complete"
