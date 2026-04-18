#!/usr/bin/env bash
set -euo pipefail

# Prepares localnet for a clean rerun while forcing manual TOML credential review.
#
# Optional env vars:
#   RESET_LOCALNET_DATA    Defaults to true; when true wipes data/alpha|beta|gamma|delta|epsilon
#   WALLET_PATH            Defaults to /tmp/localnet-author-wallet.json
#   PASSWORD               Defaults to testpass
#   WALLET_LABEL           Defaults to localnet-author
#   AUTO_INIT_WALLET       Defaults to true

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

RESET_LOCALNET_DATA="${RESET_LOCALNET_DATA:-true}"
WALLET_PATH="${WALLET_PATH:-/tmp/localnet-author-wallet.json}"
PASSWORD="${PASSWORD:-testpass}"
WALLET_LABEL="${WALLET_LABEL:-localnet-author}"
AUTO_INIT_WALLET="${AUTO_INIT_WALLET:-true}"

for cmd in cargo curl jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: required command not found: $cmd" >&2
    exit 1
  fi
done

echo "Review localnet TOML credentials before proceeding:"
for cfg in "${REPO_ROOT}/config/localnet/validator-alpha.toml" \
           "${REPO_ROOT}/config/localnet/validator-beta.toml" \
           "${REPO_ROOT}/config/localnet/validator-gamma.toml" \
           "${REPO_ROOT}/config/localnet/validator-delta.toml" \
           "${REPO_ROOT}/config/localnet/validator-epsilon.toml"; do
  echo
  echo "== ${cfg} =="
  rg -n "^(validator_id|signing_key_hex|api_port|bind_addr|network_id|manifest_enforce)" "$cfg" || true
done

echo
if [[ -t 0 ]]; then
  read -r -p "Have you manually verified the TOML credentials above? [y/N] " CONFIRM
  if [[ "${CONFIRM}" != "y" && "${CONFIRM}" != "Y" ]]; then
    echo "aborting: please verify TOML credentials first." >&2
    exit 1
  fi
else
  echo "non-interactive mode: manual TOML verification confirmation is required in interactive shell." >&2
  exit 1
fi

for port in 8081 8082 8083 8084 8085; do
  if curl -fsS "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
    echo "error: localnet appears to be running on ${port}. stop localnet before prep/reset." >&2
    exit 1
  fi
done

if [[ "$RESET_LOCALNET_DATA" == "true" ]]; then
  echo "resetting localnet data directories under ${REPO_ROOT}/data ..."
  rm -rf "${REPO_ROOT}/data/alpha" "${REPO_ROOT}/data/beta" "${REPO_ROOT}/data/gamma" "${REPO_ROOT}/data/delta" "${REPO_ROOT}/data/epsilon"
  mkdir -p "${REPO_ROOT}/data/alpha" "${REPO_ROOT}/data/beta" "${REPO_ROOT}/data/gamma" "${REPO_ROOT}/data/delta" "${REPO_ROOT}/data/epsilon"
  echo "localnet data reset complete."
else
  echo "RESET_LOCALNET_DATA=false; skipping data reset."
fi

if [[ ! -f "$WALLET_PATH" ]]; then
  if [[ "$AUTO_INIT_WALLET" == "true" ]]; then
    echo "wallet file not found: $WALLET_PATH"
    echo "auto-initializing wallet + key..."
    cargo run -q -p citizen-wallet -- init --path "$WALLET_PATH" >/dev/null
    cargo run -q -p citizen-wallet -- keygen \
      --path "$WALLET_PATH" \
      --label "$WALLET_LABEL" \
      --password "$PASSWORD" >/dev/null
  else
    echo "wallet missing and AUTO_INIT_WALLET=false; create manually before run." >&2
    exit 1
  fi
fi

echo
echo "Available wallet keys (pick AUTHOR_KEY_ID for the run script):"
KEYS_JSON="$(cargo run -q -p citizen-wallet -- list-keys --path "$WALLET_PATH")"
printf '%s\n' "$KEYS_JSON" | jq .

echo
echo "Next: run"
echo "  AUTHOR_KEY_ID=<paste_key_id> ${REPO_ROOT}/scripts/check_localnet_replication_finality.sh"
