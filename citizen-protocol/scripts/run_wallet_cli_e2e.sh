#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="${ROOT_DIR}/.tmp-wallet-e2e"
WALLET_PATH="${TMP_DIR}/wallet.json"
RECEIPTS_PATH="${TMP_DIR}/receipts.json"

rm -rf "${TMP_DIR}"
mkdir -p "${TMP_DIR}"

pushd "${ROOT_DIR}" >/dev/null
cargo run -p citizen-wallet-cli -- init --path "${WALLET_PATH}"
cargo run -p citizen-wallet-cli -- keygen --path "${WALLET_PATH}" --label "e2e" --password "test-pass"
KEY_ID=$(cargo run -p citizen-wallet-cli -- list-keys --path "${WALLET_PATH}" | python -c 'import json,sys;print(json.load(sys.stdin)[0]["key_id"])')
ENTRY=$(cargo run -p citizen-wallet-cli -- sign-identity-register --path "${WALLET_PATH}" --key-id "${KEY_ID}" --subject "did:ledger:test" --claims-hash "abc123" --author "did:ledger:test" --password "test-pass")

# Localnet submission is optional in CI/dev environments where node API may not be running.
if curl -sSf "http://127.0.0.1:8080/health" >/dev/null 2>&1; then
  cargo run -p citizen-wallet-cli -- submit --entry-json "${ENTRY}" --receipts-path "${RECEIPTS_PATH}" >/dev/null
  cargo run -p citizen-wallet-cli -- list-receipts --receipts-path "${RECEIPTS_PATH}" >/dev/null
else
  echo "WARN: localnet API unavailable at http://127.0.0.1:8080; skipping submit/list-receipts step"
fi

popd >/dev/null

echo "wallet CLI E2E complete"
