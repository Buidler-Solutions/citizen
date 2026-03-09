#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[smoke] missing required command: $1" >&2
    exit 1
  fi
}

require_cmd cargo
require_cmd curl
require_cmd python

export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-target-smoke}"
LOG_FILE="${LOG_FILE:-node-smoke.log}"
CONFIG_PATH="${1:-config/localnet/validator-alpha.toml}"
SPONSOR_BUILDER_ID="${SPONSOR_BUILDER_ID:-builder:city-records-labs}"
CREDIT_GRANT_ID="${CREDIT_GRANT_ID:-}"

if [[ -z "${CREDIT_GRANT_ID}" ]]; then
  echo "[smoke] missing CREDIT_GRANT_ID env var. submit a valid MULTISIG_CREDIT_GRANT first (see docs/LOCALNET_80_QUORUM_MULTISIG_RUNBOOK.md)" >&2
  exit 1
fi

cleanup() {
  if [[ -n "${NODE_PID:-}" ]]; then
    kill "$NODE_PID" 2>/dev/null || true
    wait "$NODE_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "[smoke] starting node with ${CONFIG_PATH}"
cargo run -p citizen-node -- "$CONFIG_PATH" >"$LOG_FILE" 2>&1 &
NODE_PID=$!

for i in {1..1200}; do
  if curl -fsS http://127.0.0.1:8081/health >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "[smoke] health"
curl -sS http://127.0.0.1:8081/health

NOW="$(date +%s)"
ENTRY_ID="$(python - <<'PY'
import uuid
print(uuid.uuid4())
PY
)"

read -r -d '' PAYLOAD <<JSON || true
{"entry_id":"${ENTRY_ID}","namespace":"audit.procurement","action":"RECORD_EVENT","object_id":"BID-001","payload":{"event":"BID_OPENED","document_hash":"sha256:test","credit_grant_id":"${CREDIT_GRANT_ID}","sponsor_builder_id":"${SPONSOR_BUILDER_ID}"},"author":"audit.procurement","signature":"sig-local","timestamp":${NOW}}
JSON

echo "[smoke] submitting entry"
RESPONSE="$(curl -sS -X POST http://127.0.0.1:8081/api/v1/entries/submit -H 'content-type: application/json' -d "$PAYLOAD")"
echo "$RESPONSE"

python - <<'PY' "$RESPONSE"
import json
import sys

body = json.loads(sys.argv[1])
if body.get("status") != "accepted":
    raise SystemExit(f"submission did not return accepted: {body}")
print(f"[smoke] accepted receipt: {body['receipt']['receipt_id']}")
PY
