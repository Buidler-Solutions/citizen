#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
WALLET_PATH="${TMP_DIR}/wallet.json"
ENTRY_PATH="${TMP_DIR}/selective_encrypted_entry.json"

cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

WALLET_CMD=(cargo run -p citizen-wallet --)

pushd "${ROOT_DIR}" >/dev/null

"${WALLET_CMD[@]}" init --path "${WALLET_PATH}" >/dev/null
"${WALLET_CMD[@]}" keygen --path "${WALLET_PATH}" --label selective-e2e --password testpass >/dev/null

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
  --object-id AUD-CLI-SELECTIVE-1 \
  --author did:ledger:auditor \
  --payload-json '{"public_fields":{"event":"BID_OPENED","document_hash":"abc123"},"private_fields":{"vendor_email":"alice@example.org","amount":1200},"public_allowlist":["document_hash","event"]}' \
  --password testpass \
  --encrypt \
  --encryption-passphrase test-entry-passphrase \
  > "${ENTRY_PATH}"

python - <<PY
import json
from pathlib import Path
entry = json.loads(Path("${ENTRY_PATH}").read_text())
assert entry["privacy_flag"] is True
assert entry["payload"]["privacy_mode"] == "field_selective_v1"
assert entry["payload"]["public_allowlist"] == ["document_hash", "event"]
assert "public_fields" in entry["payload"]
assert "public_fields_commitment" in entry["payload"]
assert "encrypted_fields_commitment" in entry["payload"]
assert "ciphertext_hex" in entry and entry["ciphertext_hex"]
assert "payload_commitment" in entry and entry["payload_commitment"]
PY

PUB_KEY=$("${WALLET_CMD[@]}" public-key --path "${WALLET_PATH}" --key-id "${KEY_ID}")
"${WALLET_CMD[@]}" verify-entry --entry-json "$(cat "${ENTRY_PATH}")" --public-key "${PUB_KEY}" >/dev/null

popd >/dev/null

echo "selective encrypt-then-commit wallet smoke passed"
