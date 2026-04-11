#!/usr/bin/env bash
set -euo pipefail

# Proves localnet finality + replication across alpha/beta/gamma after a real write.
#
# Required env vars:
#   AUTHOR_KEY_ID                  Wallet key id used to sign the test entry.
# Optional env vars:
#   WALLET_PATH                    Defaults to /tmp/localnet-author-wallet.json
#   PASSWORD                       Defaults to testpass
#   API_URL                        Defaults to http://127.0.0.1:8081
#   NAMESPACE                      Defaults to content.article
#   ACTION                         Defaults to PUBLISH_ARTICLE
#   AUTHOR_DID                     Defaults to did:example:newsroom.local

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

WALLET_PATH="${WALLET_PATH:-/tmp/localnet-author-wallet.json}"
PASSWORD="${PASSWORD:-testpass}"
API_URL="${API_URL:-http://127.0.0.1:8081}"
NAMESPACE="${NAMESPACE:-content.article}"
ACTION="${ACTION:-PUBLISH_ARTICLE}"
AUTHOR_DID="${AUTHOR_DID:-did:example:newsroom.local}"

if [[ -z "${AUTHOR_KEY_ID:-}" ]]; then
  echo "error: AUTHOR_KEY_ID is required" >&2
  echo "hint: export AUTHOR_KEY_ID=..." >&2
  exit 1
fi

for cmd in cargo curl jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: required command not found: $cmd" >&2
    exit 1
  fi
done

if [[ ! -f "$WALLET_PATH" ]]; then
  echo "error: wallet file not found: $WALLET_PATH" >&2
  exit 1
fi

cd "$REPO_ROOT"

echo "[1/5] health check on 8081/8082/8083"
for port in 8081 8082 8083; do
  echo "== $port =="
  curl -fsS "http://127.0.0.1:${port}/health" | jq
  echo
 done

OBJECT_ID="article:replication-check-$(date +%s)"
PAYLOAD_JSON=$(jq -cn \
  --arg title "Replication check" \
  --arg content "hello localnet" \
  --arg network "citizen-localnet" \
  '{title: $title, content: $content, network: $network}')

echo "[2/5] sign + submit one real entry"
ENTRY_JSON=$(cargo run -q -p citizen-wallet -- sign-entry \
  --path "$WALLET_PATH" \
  --key-id "$AUTHOR_KEY_ID" \
  --namespace "$NAMESPACE" \
  --action "$ACTION" \
  --object-id "$OBJECT_ID" \
  --author "$AUTHOR_DID" \
  --payload-json "$PAYLOAD_JSON" \
  --password "$PASSWORD")

SUBMIT_RESPONSE=$(cargo run -q -p citizen-wallet -- submit \
  --entry-json "$ENTRY_JSON" \
  --api-url "$API_URL")

RECEIPT_ID=$(printf '%s\n' "$SUBMIT_RESPONSE" | jq -r '.receipt.receipt_id')
if [[ -z "$RECEIPT_ID" || "$RECEIPT_ID" == "null" ]]; then
  echo "error: missing receipt_id in submit response" >&2
  printf '%s\n' "$SUBMIT_RESPONSE" | jq . >&2 || true
  exit 1
fi

echo "OBJECT_ID=$OBJECT_ID"
echo "RECEIPT_ID=$RECEIPT_ID"
echo

echo "[3/5] prove finality on alpha (8081)"
curl -fsS "http://127.0.0.1:8081/api/v1/receipts/$RECEIPT_ID" \
  | jq '{status: .receipt.status, block_height: .receipt.finality.block_height, participants: .receipt.finality.commit_proof.participant_ids}'
echo

echo "[4/5] prove receipt/block-height convergence on all 3 nodes"
for port in 8081 8082 8083; do
  echo "== $port =="
  curl -fsS "http://127.0.0.1:${port}/api/v1/receipts/$RECEIPT_ID" \
    | jq '{status: .receipt.status, block_height: .receipt.finality.block_height}'
  echo
 done

echo "[5/5] prove entry replication for OBJECT_ID across all nodes"
for port in 8081 8082 8083; do
  echo "== $port =="
  curl -fsS "http://127.0.0.1:${port}/entries/${NAMESPACE}" \
    | jq --arg oid "$OBJECT_ID" '.entries // . | map(select(.object_id == $oid)) | length'
  echo
 done

echo "done: finality + replication checks completed"
