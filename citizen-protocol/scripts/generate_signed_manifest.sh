#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/generate_signed_manifest.sh \
    --payload <manifest-payload.json> \
    --private-key <ed25519-private-key.pem> \
    --key-id <ed25519-public-key-hex> \
    [--output <signed-manifest.json>]

Description:
  Generates a signed Citizen admission manifest in this exact format:

  {
    "payload": { ... },
    "signatures": [
      {
        "key_id": "<hex public key>",
        "algorithm": "ed25519",
        "signature": "<hex signature>"
      }
    ]
  }

Notes:
  - Payload is canonicalized (sorted keys, compact separators) before signing.
  - Signature algorithm is fixed to ed25519.
  - Requires: python3, openssl.
USAGE
}

require_cmd() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "error: required command not found: $name" >&2
    exit 1
  fi
}

PAYLOAD_PATH=""
PRIVATE_KEY_PATH=""
KEY_ID=""
OUTPUT_PATH="signed-manifest.json"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --payload)
      PAYLOAD_PATH="${2:-}"
      shift 2
      ;;
    --private-key)
      PRIVATE_KEY_PATH="${2:-}"
      shift 2
      ;;
    --key-id)
      KEY_ID="${2:-}"
      shift 2
      ;;
    --output)
      OUTPUT_PATH="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$PAYLOAD_PATH" || -z "$PRIVATE_KEY_PATH" || -z "$KEY_ID" ]]; then
  echo "error: --payload, --private-key, and --key-id are required" >&2
  usage >&2
  exit 1
fi

if [[ ! -f "$PAYLOAD_PATH" ]]; then
  echo "error: payload file not found: $PAYLOAD_PATH" >&2
  exit 1
fi

if [[ ! -f "$PRIVATE_KEY_PATH" ]]; then
  echo "error: private key file not found: $PRIVATE_KEY_PATH" >&2
  exit 1
fi

if [[ ! "$KEY_ID" =~ ^[0-9a-fA-F]{64}$ ]]; then
  echo "error: --key-id must be a 32-byte ed25519 public key hex string (64 hex chars)" >&2
  exit 1
fi

require_cmd python3
require_cmd openssl
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT
canonical_payload="$workdir/payload.canonical.json"
signature_bin="$workdir/signature.bin"

python3 - "$PAYLOAD_PATH" "$canonical_payload" <<'PY'
import json
import sys

src, dst = sys.argv[1], sys.argv[2]
with open(src, 'r', encoding='utf-8') as f:
    payload = json.load(f)
with open(dst, 'w', encoding='utf-8') as f:
    json.dump(payload, f, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
PY

openssl pkeyutl -sign -rawin \
  -inkey "$PRIVATE_KEY_PATH" \
  -in "$canonical_payload" \
  -out "$signature_bin"

signature_hex="$(od -An -v -tx1 "$signature_bin" | tr -d ' \n')"

python3 - "$canonical_payload" "$signature_hex" "$KEY_ID" "$OUTPUT_PATH" <<'PY'
import json
import sys

canonical_payload_path, signature_hex, key_id, output_path = sys.argv[1:5]
with open(canonical_payload_path, 'r', encoding='utf-8') as f:
    payload = json.load(f)

signed_manifest = {
    "payload": payload,
    "signatures": [
        {
            "key_id": key_id.lower(),
            "algorithm": "ed25519",
            "signature": signature_hex,
        }
    ],
}

with open(output_path, 'w', encoding='utf-8') as f:
    json.dump(signed_manifest, f, indent=2)
    f.write('\n')
PY

echo "Generated signed manifest: $OUTPUT_PATH"
