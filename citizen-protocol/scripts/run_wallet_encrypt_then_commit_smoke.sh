#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
WALLET_PATH="${TMP_DIR}/wallet.json"
ENTRY_PATH="${TMP_DIR}/encrypted_entry.json"

cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

WALLET_CMD=(cargo run -p citizen-wallet --)

pushd "${ROOT_DIR}" >/dev/null

"${WALLET_CMD[@]}" init --path "${WALLET_PATH}" >/dev/null
"${WALLET_CMD[@]}" keygen --path "${WALLET_PATH}" --label e2e --password testpass >/dev/null

KEY_ID=$(python - <<PY
import json
from pathlib import Path
record = json.loads(Path("${WALLET_PATH}").read_text())
print(record["keys"][0]["key_id"])
PY
)

"${WALLET_CMD[@]}" sign-entry \
  --path "${WALLET_PATH}" \
  --key-id "${KEY_ID}" \
  --namespace audit.procurement \
  --action RECORD_EVENT \
  --object-id AUD-CLI-1 \
  --author did:ledger:auditor \
  --payload-json '{"event":"BID_OPENED","document_hash":"abc123"}' \
  --password testpass \
  --encrypt \
  --encryption-passphrase test-entry-passphrase \
  > "${ENTRY_PATH}"

PUB_KEY=$("${WALLET_CMD[@]}" public-key --path "${WALLET_PATH}" --key-id "${KEY_ID}")
"${WALLET_CMD[@]}" verify-entry --entry-json "$(cat "${ENTRY_PATH}")" --public-key "${PUB_KEY}"

popd >/dev/null

echo "encrypt-then-commit wallet smoke passed"
