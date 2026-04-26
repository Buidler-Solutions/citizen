#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  citizen-protocol/scripts/bootstrap_single_validator_observer.sh \
    --validator-config <validator.toml> \
    --observer-config <observer.toml> \
    --signer-private-key <manifest-signer-ed25519.pem> \
    --genesis-hash <canonical-genesis-hash> \
    --validator-public-key <validator-ed25519-public-key-hex> \
    [--validator-id <validator-id>] \
    [--network-id <network-id>] \
    [--boot-node <host:port>] \
    [--manifest-id <manifest-id>] \
    [--payload-out <manifest.payload.json>] \
    [--signed-out <signed-manifest.json>]

Description:
  Automates local single-validator + observer manifest bootstrap:
    1) Generates manifest payload JSON with current issued_at.
    2) Signs payload into signed-manifest.json.
    3) Patches validator + observer TOML configs to enforce manifest with the signed path.

Notes:
  - Requires: bash, python3, openssl.
  - Uses citizen-protocol/scripts/generate_signed_manifest.sh for signing.
USAGE
}

require_cmd() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "error: required command not found: $name" >&2
    exit 1
  fi
}

VALIDATOR_CONFIG=""
OBSERVER_CONFIG=""
SIGNER_PRIVATE_KEY=""
GENESIS_HASH=""
VALIDATOR_PUBLIC_KEY=""
VALIDATOR_ID="local-validator-1"
NETWORK_ID="citizen-local"
BOOT_NODE="127.0.0.1:9300"
MANIFEST_ID="citizen-local-single-validator-v1"
PAYLOAD_OUT="config/local/manifest.payload.json"
SIGNED_OUT="config/local/signed-manifest.json"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --validator-config)
      VALIDATOR_CONFIG="${2:-}"
      shift 2
      ;;
    --observer-config)
      OBSERVER_CONFIG="${2:-}"
      shift 2
      ;;
    --signer-private-key)
      SIGNER_PRIVATE_KEY="${2:-}"
      shift 2
      ;;
    --genesis-hash)
      GENESIS_HASH="${2:-}"
      shift 2
      ;;
    --validator-public-key)
      VALIDATOR_PUBLIC_KEY="${2:-}"
      shift 2
      ;;
    --validator-id)
      VALIDATOR_ID="${2:-}"
      shift 2
      ;;
    --network-id)
      NETWORK_ID="${2:-}"
      shift 2
      ;;
    --boot-node)
      BOOT_NODE="${2:-}"
      shift 2
      ;;
    --manifest-id)
      MANIFEST_ID="${2:-}"
      shift 2
      ;;
    --payload-out)
      PAYLOAD_OUT="${2:-}"
      shift 2
      ;;
    --signed-out)
      SIGNED_OUT="${2:-}"
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

if [[ -z "$VALIDATOR_CONFIG" || -z "$OBSERVER_CONFIG" || -z "$SIGNER_PRIVATE_KEY" || -z "$GENESIS_HASH" || -z "$VALIDATOR_PUBLIC_KEY" ]]; then
  echo "error: required flags missing" >&2
  usage >&2
  exit 1
fi

require_cmd python3
require_cmd openssl

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SIGN_SCRIPT="$REPO_ROOT/citizen-protocol/scripts/generate_signed_manifest.sh"

if [[ ! -x "$SIGN_SCRIPT" ]]; then
  echo "error: signer helper not executable: $SIGN_SCRIPT" >&2
  exit 1
fi

abs_path() {
  python3 - "$1" <<'PY'
import os
import sys
print(os.path.abspath(sys.argv[1]))
PY
}

VALIDATOR_CONFIG_ABS="$(abs_path "$VALIDATOR_CONFIG")"
OBSERVER_CONFIG_ABS="$(abs_path "$OBSERVER_CONFIG")"
SIGNER_PRIVATE_KEY_ABS="$(abs_path "$SIGNER_PRIVATE_KEY")"
PAYLOAD_OUT_ABS="$(abs_path "$PAYLOAD_OUT")"
SIGNED_OUT_ABS="$(abs_path "$SIGNED_OUT")"

for file in "$VALIDATOR_CONFIG_ABS" "$OBSERVER_CONFIG_ABS" "$SIGNER_PRIVATE_KEY_ABS"; do
  if [[ ! -f "$file" ]]; then
    echo "error: file not found: $file" >&2
    exit 1
  fi
done

mkdir -p "$(dirname "$PAYLOAD_OUT_ABS")"
mkdir -p "$(dirname "$SIGNED_OUT_ABS")"

ISSUED_AT="$(date +%s)"

python3 - "$PAYLOAD_OUT_ABS" "$NETWORK_ID" "$GENESIS_HASH" "$BOOT_NODE" "$VALIDATOR_ID" "$VALIDATOR_PUBLIC_KEY" "$ISSUED_AT" "$MANIFEST_ID" <<'PY'
import json
import sys

out_path, network_id, genesis_hash, boot_node, validator_id, public_key, issued_at, manifest_id = sys.argv[1:]
payload = {
    "network_id": network_id,
    "genesis_hash": genesis_hash,
    "boot_nodes": [boot_node],
    "validator_allowlist": [
        {
            "validator_id": validator_id,
            "public_key": public_key,
        }
    ],
    "issued_at": int(issued_at),
    "version": 1,
    "manifest_id": manifest_id,
}
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(payload, f, indent=2)
    f.write("\n")
PY

KEY_ID="$(openssl pkey -in "$SIGNER_PRIVATE_KEY_ABS" -pubout -outform DER | tail -c 32 | od -An -v -tx1 | tr -d ' \n')"

"$SIGN_SCRIPT" \
  --payload "$PAYLOAD_OUT_ABS" \
  --private-key "$SIGNER_PRIVATE_KEY_ABS" \
  --key-id "$KEY_ID" \
  --output "$SIGNED_OUT_ABS"

patch_config() {
  local config_path="$1"
  local network_id="$2"
  local signed_manifest_path="$3"

  python3 - "$config_path" "$network_id" "$signed_manifest_path" <<'PY'
import re
import sys

path, network_id, manifest_path = sys.argv[1:]
with open(path, "r", encoding="utf-8") as f:
    text = f.read()

def upsert(src: str, key: str, value: str) -> str:
    pattern = re.compile(rf"(?m)^\s*{re.escape(key)}\s*=\s*.*$")
    line = f'{key} = "{value}"' if isinstance(value, str) else f"{key} = {value}"
    if pattern.search(src):
        return pattern.sub(line, src, count=1)
    return src.rstrip() + "\n" + line + "\n"

text = upsert(text, "network_id", network_id)
text = upsert(text, "manifest_path", manifest_path)
text = upsert(text, "manifest_enforce", "true")

with open(path, "w", encoding="utf-8") as f:
    f.write(text)
PY
}

patch_config "$VALIDATOR_CONFIG_ABS" "$NETWORK_ID" "$SIGNED_OUT_ABS"
patch_config "$OBSERVER_CONFIG_ABS" "$NETWORK_ID" "$SIGNED_OUT_ABS"

echo "✅ Generated payload: $PAYLOAD_OUT_ABS"
echo "✅ Generated signed manifest: $SIGNED_OUT_ABS"
echo "✅ Patched validator config: $VALIDATOR_CONFIG_ABS"
echo "✅ Patched observer config: $OBSERVER_CONFIG_ABS"
echo
echo "Next:"
echo "  cargo run -p citizen-node -- $VALIDATOR_CONFIG_ABS"
echo "  cargo run -p citizen-node -- $OBSERVER_CONFIG_ABS"
