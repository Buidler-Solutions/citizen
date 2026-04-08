#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

for cmd in cargo curl jq mktemp openssl python3; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "required command missing: $cmd" >&2
    exit 1
  fi
done

rm -rf data/alpha data/beta data/gamma
mkdir -p docs/artifacts data/alpha data/beta data/gamma

evidence_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
evidence_file="docs/artifacts/api-consensus-sync-baseline-${evidence_stamp}.md"
build_timeout_seconds="${CARGO_BUILD_TIMEOUT_SECONDS:-900}"
startup_timeout_seconds="${LOCALNET_STARTUP_TIMEOUT_SECONDS:-45}"
post_submit_wait_seconds="${POST_SUBMIT_WAIT_SECONDS:-4}"
entry_visibility_timeout_seconds="${ENTRY_VISIBILITY_TIMEOUT_SECONDS:-20}"

configs=(
  "config/localnet/validator-alpha.toml"
  "config/localnet/validator-beta.toml"
  "config/localnet/validator-gamma.toml"
)
ports=(8081 8082 8083)

latest_height_for_port() {
  local port="$1"
  local height=0
  while true; do
    local next_height=$((height + 1))
    local block_response
    block_response="$(curl -fsS "http://127.0.0.1:${port}/blocks/${next_height}")"
    local has_block
    has_block="$(jq -r '.block != null' <<<"$block_response")"
    if [[ "$has_block" == "true" ]]; then
      height="$next_height"
    else
      break
    fi
  done
  echo "$height"
}

cleanup() {
  for pid in "${node_pids[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  rm -rf "${tmp_config_dir:-}"
  rm -rf "${tmp_signing_dir:-}"
}

trap cleanup EXIT

node_pids=()
tmp_config_dir="$(mktemp -d)"

print_json_or_raw() {
  local payload="$1"
  if jq -e . >/dev/null 2>&1 <<<"$payload"; then
    jq '.' <<<"$payload"
  else
    echo "$payload"
  fi
}

node_bin="${NODE_BIN:-$ROOT_DIR/target/debug/citizen-node}"
if [[ -x "$node_bin" ]]; then
  echo "[baseline] using existing citizen-node binary at ${node_bin}"
else
  echo "[baseline] building citizen-node binary (timeout: ${build_timeout_seconds}s)"
  if ! timeout "$build_timeout_seconds" cargo build -p citizen-node >/dev/null; then
    echo "[baseline] failed to build citizen-node within timeout (${build_timeout_seconds}s)" >&2
    exit 4
  fi
fi

for cfg in "${configs[@]}"; do
  cfg_name="$(basename "$cfg")"
  sed 's/^api_local_finalize_mode = false/api_local_finalize_mode = true/' "$cfg" >"$tmp_config_dir/$cfg_name"
done

for i in "${!configs[@]}"; do
  cfg_name="$(basename "${configs[$i]}")"
  name="$(basename "$cfg_name" .toml)"
  log_file="data/${name}.log"
  : >"$log_file"
  echo "[baseline] starting ${name} (${ports[$i]}) with api_local_finalize_mode=true"
  RUST_LOG=info "$node_bin" "$tmp_config_dir/$cfg_name" >"$log_file" 2>&1 &
  node_pids+=("$!")
done

for port in "${ports[@]}"; do
  ready=0
  for _ in $(seq 1 "$startup_timeout_seconds"); do
    if curl -fsS "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done

  if [[ "$ready" -ne 1 ]]; then
    echo "node on port ${port} failed health checks" >&2
    exit 1
  fi
done

entry_id="$(cat /proc/sys/kernel/random/uuid)"
object_suffix="$(cat /proc/sys/kernel/random/uuid)"
timestamp="$(date +%s)"
tmp_signing_dir="$(mktemp -d)"
private_key_path="$tmp_signing_dir/submitter-private.pem"
public_key_path="$tmp_signing_dir/submitter-public.pem"
openssl genpkey -algorithm Ed25519 -out "$private_key_path" >/dev/null 2>&1
openssl pkey -in "$private_key_path" -pubout -out "$public_key_path" >/dev/null 2>&1
author_public_key_hex="$(openssl pkey -pubin -in "$public_key_path" -outform DER \
  | od -An -vtx1 \
  | tr -d ' \n' \
  | sed 's/^302a300506032b6570032100//')"

submit_payload_without_signature="$(jq -cn \
  --arg entry_id "$entry_id" \
  --arg namespace "registry.land" \
  --arg action "TRANSFER_OWNERSHIP" \
  --arg object_id "LOT-API-CONSENSUS-SYNC-BASELINE-${object_suffix}" \
  --arg author "registry.land" \
  --arg author_public_key "$author_public_key_hex" \
  --arg from "did:citizen:alpha" \
  --arg to "did:citizen:beta" \
  --argjson timestamp "$timestamp" \
  '{entry_id: $entry_id, namespace: $namespace, action: $action, object_id: $object_id, payload: {from: $from, to: $to, author_public_key: $author_public_key}, author: $author, timestamp: $timestamp}')"

canonical_payload="$(python3 -c 'import json,sys; print(json.dumps(json.loads(sys.stdin.read()), sort_keys=True, separators=(",", ":")))' <<<"$submit_payload_without_signature")"
canonical_payload_path="$tmp_signing_dir/canonical-payload.json"
printf '%s' "$canonical_payload" >"$canonical_payload_path"
signature_hex="$(openssl pkeyutl -sign -rawin -inkey "$private_key_path" -in "$canonical_payload_path" \
  | od -An -vtx1 \
  | tr -d ' \n')"

submit_payload="$(jq -cn \
  --argjson base "$submit_payload_without_signature" \
  --arg signature "$signature_hex" \
  '$base + {signature: $signature}')"

submit_response="$(curl -sS -X POST \
  http://127.0.0.1:8081/api/v1/entries/submit \
  -H 'Content-Type: application/json' \
  -d "$submit_payload")"

if jq -e '.error' >/dev/null 2>&1 <<<"$submit_response"; then
  echo "[baseline] submit failed: $submit_response" >&2
  exit 5
fi

sleep "$post_submit_wait_seconds"
alpha_entries='[]'
beta_entries='[]'
gamma_entries='[]'
alpha_contains="false"
beta_contains="false"
gamma_contains="false"
for _ in $(seq 1 "$entry_visibility_timeout_seconds"); do
  alpha_entries_response="$(curl -fsS http://127.0.0.1:8081/entries/registry.land)"
  beta_entries_response="$(curl -fsS http://127.0.0.1:8082/entries/registry.land)"
  gamma_entries_response="$(curl -fsS http://127.0.0.1:8083/entries/registry.land)"

  alpha_entries="$(jq -c '.entries // .' <<<"$alpha_entries_response")"
  beta_entries="$(jq -c '.entries // .' <<<"$beta_entries_response")"
  gamma_entries="$(jq -c '.entries // .' <<<"$gamma_entries_response")"

  alpha_contains="$(jq --arg id "$entry_id" 'any(.[]; .entry_id == $id)' <<<"$alpha_entries")"
  beta_contains="$(jq --arg id "$entry_id" 'any(.[]; .entry_id == $id)' <<<"$beta_entries")"
  gamma_contains="$(jq --arg id "$entry_id" 'any(.[]; .entry_id == $id)' <<<"$gamma_entries")"

  if [[ "$alpha_contains" == "true" ]]; then
    break
  fi
  sleep 1
done

alpha_count="$(jq 'length' <<<"$alpha_entries")"
beta_count="$(jq 'length' <<<"$beta_entries")"
gamma_count="$(jq 'length' <<<"$gamma_entries")"

alpha_height="$(latest_height_for_port 8081)"
beta_height="$(latest_height_for_port 8082)"
gamma_height="$(latest_height_for_port 8083)"

{
  echo "# API Consensus Sync Baseline Evidence (${evidence_stamp})"
  echo
  echo "## Mode"
  echo '- validator configs forced to `api_local_finalize_mode = true` during this run'
  echo
  echo "## Submission"
  echo '```json'
  echo "$submit_payload"
  echo '```'
  echo
  echo "### Alpha submit response"
  echo '```json'
  print_json_or_raw "$submit_response"
  echo '```'
  echo
  echo "## Divergence check"
  echo "- Alpha contains entry: ${alpha_contains}"
  echo "- Beta contains entry: ${beta_contains}"
  echo "- Gamma contains entry: ${gamma_contains}"
  echo "- Entry counts (alpha/beta/gamma): ${alpha_count}/${beta_count}/${gamma_count}"
  echo "- Heights (alpha/beta/gamma): ${alpha_height}/${beta_height}/${gamma_height}"
  echo
  echo "## API snapshots"
  echo "### Alpha registry.land entries"
  echo '```json'
  echo "$alpha_entries" | jq '.'
  echo '```'
  echo
  echo "### Beta registry.land entries"
  echo '```json'
  echo "$beta_entries" | jq '.'
  echo '```'
  echo
  echo "### Gamma registry.land entries"
  echo '```json'
  echo "$gamma_entries" | jq '.'
  echo '```'
  echo
  echo "## Node log tails"
  echo '```text'
  tail -n 40 data/validator-alpha.log
  tail -n 40 data/validator-beta.log
  tail -n 40 data/validator-gamma.log
  echo '```'
} >"$evidence_file"

echo "[baseline] wrote ${evidence_file}"

if [[ "$alpha_contains" != "true" ]]; then
  echo "[baseline] expected alpha to contain entry" >&2
  exit 2
fi

if [[ "$beta_contains" != "false" || "$gamma_contains" != "false" ]]; then
  echo "[baseline] expected beta/gamma to miss entry in baseline mode" >&2
  exit 3
fi

echo "[baseline] baseline divergence verified"
