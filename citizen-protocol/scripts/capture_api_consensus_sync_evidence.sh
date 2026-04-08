#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

for cmd in cargo curl jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "required command missing: $cmd" >&2
    exit 1
  fi
done

mkdir -p docs/artifacts data/alpha data/beta data/gamma

evidence_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
evidence_file="docs/artifacts/api-consensus-sync-localnet-${evidence_stamp}.md"

configs=(
  "config/localnet/validator-alpha.toml"
  "config/localnet/validator-beta.toml"
  "config/localnet/validator-gamma.toml"
)
ports=(8081 8082 8083)

cleanup() {
  for pid in "${node_pids[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
}

trap cleanup EXIT

node_pids=()

echo "[evidence] building citizen-node binary"
cargo build -p citizen-node >/dev/null
node_bin="$ROOT_DIR/target/debug/citizen-node"

for i in "${!configs[@]}"; do
  cfg="${configs[$i]}"
  name="$(basename "$cfg" .toml)"
  log_file="data/${name}.log"
  : >"$log_file"
  echo "[evidence] starting ${name} (${ports[$i]})"
  RUST_LOG=info "$node_bin" "$cfg" >"$log_file" 2>&1 &
  node_pids+=("$!")
done

for port in "${ports[@]}"; do
  ready=0
  for _ in $(seq 1 45); do
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

entry_id="api-consensus-sync-${evidence_stamp}"
timestamp="$(date +%s)"
submit_payload="$(jq -cn \
  --arg entry_id "$entry_id" \
  --arg namespace "registry.land" \
  --arg action "TRANSFER_OWNERSHIP" \
  --arg object_id "LOT-API-CONSENSUS-SYNC" \
  --arg author "registry.land" \
  --arg signature "sig" \
  --arg from "did:citizen:alpha" \
  --arg to "did:citizen:beta" \
  --argjson timestamp "$timestamp" \
  '{entry_id: $entry_id, namespace: $namespace, action: $action, object_id: $object_id, payload: {from: $from, to: $to}, author: $author, signature: $signature, timestamp: $timestamp}')"

submit_response="$(curl -sS -X POST \
  http://127.0.0.1:8081/api/v1/entries/submit \
  -H 'Content-Type: application/json' \
  -d "$submit_payload")"

sleep 4

alpha_entries="$(curl -sS http://127.0.0.1:8081/api/v1/namespaces/registry.land/entries)"
beta_entries="$(curl -sS http://127.0.0.1:8082/api/v1/namespaces/registry.land/entries)"
gamma_entries="$(curl -sS http://127.0.0.1:8083/api/v1/namespaces/registry.land/entries)"

alpha_count="$(jq 'length' <<<"$alpha_entries")"
beta_count="$(jq 'length' <<<"$beta_entries")"
gamma_count="$(jq 'length' <<<"$gamma_entries")"

alpha_contains="$(jq --arg id "$entry_id" 'any(.[]; .entry_id == $id)' <<<"$alpha_entries")"
beta_contains="$(jq --arg id "$entry_id" 'any(.[]; .entry_id == $id)' <<<"$beta_entries")"
gamma_contains="$(jq --arg id "$entry_id" 'any(.[]; .entry_id == $id)' <<<"$gamma_entries")"

alpha_height="$(curl -sS http://127.0.0.1:8081/api/v1/status | jq '.latest_height')"
beta_height="$(curl -sS http://127.0.0.1:8082/api/v1/status | jq '.latest_height')"
gamma_height="$(curl -sS http://127.0.0.1:8083/api/v1/status | jq '.latest_height')"

{
  echo "# API Consensus Sync Localnet Evidence (${evidence_stamp})"
  echo
  echo "## Submission"
  echo '```json'
  echo "$submit_payload"
  echo '```'
  echo
  echo "### Alpha submit response"
  echo '```json'
  echo "$submit_response" | jq '.'
  echo '```'
  echo
  echo "## Convergence check"
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

echo "[evidence] wrote ${evidence_file}"

if [[ "$alpha_contains" != "true" || "$beta_contains" != "true" || "$gamma_contains" != "true" ]]; then
  echo "[evidence] convergence check failed" >&2
  exit 2
fi

if [[ "$alpha_height" != "$beta_height" || "$beta_height" != "$gamma_height" ]]; then
  echo "[evidence] height mismatch detected" >&2
  exit 3
fi

echo "[evidence] convergence verified"
