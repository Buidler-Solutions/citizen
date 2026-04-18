#!/usr/bin/env bash
set -euo pipefail

# Proves localnet finality + replication across all five localnet validators
# after real signed writes. Also reports inferred runtime roles:
# - validators observed in commit participant_ids => active voting set
# - validators converging on blocks but not in participant_ids => standby syncing set
#
# Required env vars:
#   AUTHOR_KEY_ID                  Wallet key id used to sign test entries.
# Optional env vars:
#   WALLET_PATH                    Defaults to /tmp/localnet-author-wallet.json
#   PASSWORD                       Defaults to testpass
#   WALLET_LABEL                   Defaults to localnet-author (used when keygen runs)
#   AUTO_INIT_WALLET               Defaults to true; auto-creates wallet/key if missing
#   AUTHOR_KEY_LABEL               Optional label-based key lookup when AUTHOR_KEY_ID is unset
#   API_URL                        Defaults to http://127.0.0.1:8081 (submission endpoint)
#   API_SUBMIT_ENDPOINT            Defaults to /api/v1/entries/submit
#   NAMESPACE                      Defaults to forms.commitment
#   ACTION                         Defaults to COMMIT_FORM
#   AUTHOR_DID                     Defaults to forms.commitment
#   WRITE_COUNT                    Defaults to 3; number of entries submitted for role sampling
#   SPONSOR_BUILDER_ID             Defaults to builder:city-records-labs
#   CREDIT_GRANT_ID                Optional explicit active builder grant entry_id to reuse
#   AUTO_BOOTSTRAP_CREDIT_GRANT    Defaults to true; auto-creates a localnet 3-of-5 multisig grant when missing
#   AUTHOR_PUBLIC_KEY_HEX          Optional explicit Ed25519 public key; auto-resolved from wallet key when omitted
#   DISABLE_CREDIT_GRANT           Defaults to false; skip grant bootstrap/linkage fields in test payloads

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

WALLET_PATH="${WALLET_PATH:-/tmp/localnet-author-wallet.json}"
PASSWORD="${PASSWORD:-testpass}"
WALLET_LABEL="${WALLET_LABEL:-localnet-author}"
AUTO_INIT_WALLET="${AUTO_INIT_WALLET:-true}"
AUTHOR_KEY_LABEL="${AUTHOR_KEY_LABEL:-}"
API_URL="${API_URL:-http://127.0.0.1:8081}"
API_SUBMIT_ENDPOINT="${API_SUBMIT_ENDPOINT:-/api/v1/entries/submit}"
NAMESPACE="${NAMESPACE:-forms.commitment}"
ACTION="${ACTION:-COMMIT_FORM}"
AUTHOR_DID="${AUTHOR_DID:-forms.commitment}"
WRITE_COUNT="${WRITE_COUNT:-3}"
SPONSOR_BUILDER_ID="${SPONSOR_BUILDER_ID:-builder:city-records-labs}"
CREDIT_GRANT_ID="${CREDIT_GRANT_ID:-}"
AUTO_BOOTSTRAP_CREDIT_GRANT="${AUTO_BOOTSTRAP_CREDIT_GRANT:-true}"
AUTHOR_PUBLIC_KEY_HEX="${AUTHOR_PUBLIC_KEY_HEX:-}"
DISABLE_CREDIT_GRANT="${DISABLE_CREDIT_GRANT:-false}"

BUILDER_CREDIT_POLICY_JSON=${BUILDER_CREDIT_POLICY_JSON:-'{"required_grant_approvals":3,"grant_approvers":[{"id":"grant:ops-1","public_key":"11eec230e93451631d92331ab14f7cd3beb71d7d0664213c3c245ee34e218bbc"},{"id":"grant:ops-2","public_key":"4fba12886de6f3955e1e00122ecfa5f28f6143b4ebfd623426b31db6e3ba759b"},{"id":"grant:ops-3","public_key":"05d820297454180f0a29826db77629efaf2866ce6321bdf1e36653fbce5f87fc"},{"id":"grant:ops-4","public_key":"871aae4a90265130ec08636783f7c6967201557511093f2ebe5b1ec3b5759500"},{"id":"grant:ops-5","public_key":"64b4461734432d8b1651171a2f4385948748665c876a377cd1722ef55389553b"}]}'}

PORTS=(8081 8082 8083 8084 8085)
VALIDATORS=(validator-alpha validator-beta validator-gamma validator-delta validator-epsilon)

for cmd in cargo curl jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: required command not found: $cmd" >&2
    exit 1
  fi
done


find_existing_credit_grant() {
  local entries_json
  entries_json="$(curl -fsS "http://127.0.0.1:8081/entries/builder.credits" 2>/dev/null || true)"
  if [[ -z "$entries_json" ]]; then
    return 0
  fi

  printf '%s\n' "$entries_json" | jq -r \
    --arg sponsor "$SPONSOR_BUILDER_ID" '
      .entries // .
      | map(select(.object_id == $sponsor and (.action == "MULTISIG_CREDIT_GRANT" or .action == "PROGRAMMABLE_CREDIT_GRANT")))
      | sort_by(.timestamp)
      | reverse
      | .[0].entry_id // empty
    '
}

submit_entry_payload() {
  local entry_json="$1"
  local request_json="$entry_json"

  if [[ "$API_SUBMIT_ENDPOINT" == "/api/v1/envelopes/submit" ]]; then
    local envelope_id submitted_at signer signature
    envelope_id="$(python - <<'PY'
import uuid
print(uuid.uuid4())
PY
)"
    submitted_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    signer="$(printf '%s\n' "$entry_json" | jq -r '.author')"
    signature="$(printf '%s\n' "$entry_json" | jq -r '.signature')"
    request_json="$(jq -cn \
      --arg envelope_id "$envelope_id" \
      --arg signer "$signer" \
      --arg signature "$signature" \
      --arg submitted_at "$submitted_at" \
      --argjson payload "$entry_json" \
      '{envelope_id:$envelope_id, signer:$signer, signature:$signature, signature_scope:null, co_signatures:[], multisig_policy:null, submitted_at:$submitted_at, payload:$payload}')"
  fi

  local response
  response="$(curl -sS -w '\n__HTTP_STATUS__:%{http_code}' \
    -H "content-type: application/json" \
    -X POST \
    --data "$request_json" \
    "${API_URL}${API_SUBMIT_ENDPOINT}")"
  local status body
  status="${response##*__HTTP_STATUS__:}"
  body="${response%__HTTP_STATUS__:*}"

  if [[ "$status" =~ ^2 ]]; then
    printf '%s\n' "$body"
    return 0
  fi

  echo "HTTP ${status}" >&2
  printf '%s\n' "$body" >&2
  return 1
}

bootstrap_credit_grant() {
  local now grant_entry proof1 proof3 proof5 grant_final submit_error
  now="$(date +%s)"
  grant_entry=$(cargo run -q -p citizen-wallet -- sign-entry \
    --path "$WALLET_PATH" \
    --key-id "$AUTHOR_KEY_ID" \
    --namespace builder.credits \
    --action MULTISIG_CREDIT_GRANT \
    --object-id "$SPONSOR_BUILDER_ID" \
    --author builder.credits \
    --payload-json "{\"amount\":1200,\"reason\":\"localnet forms.commitment bootstrap\",\"ticket_id\":\"grant-ticket-${now}\",\"author_public_key\":\"${AUTHOR_PUBLIC_KEY_HEX}\"}" \
    --password "$PASSWORD")

  CREDIT_GRANT_ID="$(printf '%s\n' "$grant_entry" | jq -r '.entry_id')"
  if [[ -z "$CREDIT_GRANT_ID" || "$CREDIT_GRANT_ID" == "null" ]]; then
    echo "error: failed to derive credit grant entry_id from grant entry" >&2
    exit 1
  fi

  proof1=$(cargo run -q -p citizen-wallet -- sign-builder-credit-proof \
    --entry-json "$grant_entry" \
    --namespace-policy-json "$BUILDER_CREDIT_POLICY_JSON" \
    --approver grant:ops-1 \
    --secret-key-hex 9a86444c078543e827a58208a0a072443a88ff5f8fe4bd3a8d375c8bf097c891 \
    --expected-public-key 11eec230e93451631d92331ab14f7cd3beb71d7d0664213c3c245ee34e218bbc)
  proof3=$(cargo run -q -p citizen-wallet -- sign-builder-credit-proof \
    --entry-json "$grant_entry" \
    --namespace-policy-json "$BUILDER_CREDIT_POLICY_JSON" \
    --approver grant:ops-3 \
    --secret-key-hex 3b40a6544ba83499ada977fdeedfc0f925509e5bb920fae29d9f30b23fb1770b \
    --expected-public-key 05d820297454180f0a29826db77629efaf2866ce6321bdf1e36653fbce5f87fc)
  proof5=$(cargo run -q -p citizen-wallet -- sign-builder-credit-proof \
    --entry-json "$grant_entry" \
    --namespace-policy-json "$BUILDER_CREDIT_POLICY_JSON" \
    --approver grant:ops-5 \
    --secret-key-hex 7ba5087c453e08e6dba4705a54a43b806a340cd875022e1a215f2af6cfc8cf8d \
    --expected-public-key 64b4461734432d8b1651171a2f4385948748665c876a377cd1722ef55389553b)

  grant_final=$(printf '%s\n' "$grant_entry" | jq -c \
    --argjson p1 "$proof1" \
    --argjson p3 "$proof3" \
    --argjson p5 "$proof5" \
    '.payload.multisig_proofs = [
      ($p1 | {approver,public_key,signature}),
      ($p3 | {approver,public_key,signature}),
      ($p5 | {approver,public_key,signature})
    ]')

  submit_error="$(mktemp)"
  if ! submit_entry_payload "$grant_final" > /dev/null 2>"$submit_error"; then
    echo "error: failed to bootstrap builder credit grant" >&2
    cat "$submit_error" >&2 || true
    rm -f "$submit_error"
    exit 1
  fi
  rm -f "$submit_error"
  echo "[grant] bootstrapped MULTISIG_CREDIT_GRANT entry_id=${CREDIT_GRANT_ID} sponsor_builder_id=${SPONSOR_BUILDER_ID}"
}

ensure_credit_grant() {
  if [[ -n "$CREDIT_GRANT_ID" ]]; then
    echo "[grant] using provided CREDIT_GRANT_ID=${CREDIT_GRANT_ID}"
    return
  fi

  local existing
  existing="$(find_existing_credit_grant)"
  if [[ -n "$existing" ]]; then
    CREDIT_GRANT_ID="$existing"
    echo "[grant] reusing existing grant entry_id=${CREDIT_GRANT_ID} sponsor_builder_id=${SPONSOR_BUILDER_ID}"
    return
  fi

  if [[ "$AUTO_BOOTSTRAP_CREDIT_GRANT" != "true" ]]; then
    echo "error: no existing builder credit grant found for ${SPONSOR_BUILDER_ID}." >&2
    echo "Set CREDIT_GRANT_ID, or rerun with AUTO_BOOTSTRAP_CREDIT_GRANT=true." >&2
    exit 1
  fi

  bootstrap_credit_grant
}

if [[ ! "$WRITE_COUNT" =~ ^[0-9]+$ ]] || [[ "$WRITE_COUNT" -lt 1 ]]; then
  echo "error: WRITE_COUNT must be a positive integer" >&2
  exit 1
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
    echo "error: wallet file not found: $WALLET_PATH" >&2
    echo "Set AUTO_INIT_WALLET=true or create one with:" >&2
    echo "  cargo run -q -p citizen-wallet -- init --path \"$WALLET_PATH\"" >&2
    echo "  cargo run -q -p citizen-wallet -- keygen --path \"$WALLET_PATH\" --label \"$WALLET_LABEL\" --password \"$PASSWORD\"" >&2
    exit 1
  fi
fi

if [[ -z "${AUTHOR_KEY_ID:-}" ]]; then
  KEYS_JSON="$(cargo run -q -p citizen-wallet -- list-keys --path "$WALLET_PATH" || true)"
  if [[ -n "$AUTHOR_KEY_LABEL" ]]; then
    MATCHED_KEY_ID="$(printf '%s\n' "$KEYS_JSON" | jq -r --arg label "$AUTHOR_KEY_LABEL" '[.[] | select(.label == $label)][0].key_id // empty')"
    if [[ -n "$MATCHED_KEY_ID" ]]; then
      AUTHOR_KEY_ID="$MATCHED_KEY_ID"
      echo "Using key matched by AUTHOR_KEY_LABEL=${AUTHOR_KEY_LABEL}: $AUTHOR_KEY_ID"
    fi
  fi
fi

if [[ -z "${AUTHOR_KEY_ID:-}" ]]; then
  echo "error: AUTHOR_KEY_ID is required." >&2
  echo "Get one with: cargo run -q -p citizen-wallet -- list-keys --path \"$WALLET_PATH\"" >&2
  echo "Then rerun: AUTHOR_KEY_ID=<paste_key_id> scripts/check_localnet_replication_finality.sh" >&2
  exit 1
fi

KEYS_JSON="$(cargo run -q -p citizen-wallet -- list-keys --path "$WALLET_PATH" || true)"
WALLET_AUTHOR_PUBLIC_KEY_HEX="$(printf '%s\n' "$KEYS_JSON" | jq -r --arg key_id "$AUTHOR_KEY_ID" '[.[] | select(.key_id == $key_id)][0].public_key // empty')"

if [[ -n "$WALLET_AUTHOR_PUBLIC_KEY_HEX" ]]; then
  if [[ -n "$AUTHOR_PUBLIC_KEY_HEX" && "$AUTHOR_PUBLIC_KEY_HEX" != "$WALLET_AUTHOR_PUBLIC_KEY_HEX" ]]; then
    echo "warning: provided AUTHOR_PUBLIC_KEY_HEX does not match wallet key ${AUTHOR_KEY_ID}; using wallet-derived key." >&2
  fi
  AUTHOR_PUBLIC_KEY_HEX="$WALLET_AUTHOR_PUBLIC_KEY_HEX"
fi

if [[ -z "$AUTHOR_PUBLIC_KEY_HEX" ]]; then
  echo "error: failed to resolve public key for AUTHOR_KEY_ID=${AUTHOR_KEY_ID}." >&2
  echo "Set AUTHOR_PUBLIC_KEY_HEX explicitly or ensure the key exists in ${WALLET_PATH}." >&2
  exit 1
fi

cd "$REPO_ROOT"

echo "[1/6] health check on 8081..8085"
for port in "${PORTS[@]}"; do
  printf '== %s ==\n' "$port"
  curl -fsS "http://127.0.0.1:${port}/health" | jq
  echo
 done

if [[ "$DISABLE_CREDIT_GRANT" != "true" ]]; then
  ensure_credit_grant
else
  echo "[grant] DISABLE_CREDIT_GRANT=true, skipping grant bootstrap/reuse and linkage fields"
fi

receipt_ids=()
object_ids=()

echo "[2/6] submit ${WRITE_COUNT} signed entries through ${API_URL}"
for i in $(seq 1 "$WRITE_COUNT"); do
  object_id="form:replication-check-${i}-$(date +%s)"
  if [[ "$DISABLE_CREDIT_GRANT" == "true" ]]; then
    payload_json=$(jq -cn \
      --arg data_hash "sha256:forms-localnet-${i}-$(date +%s)" \
      --arg encrypted_form_url "https://localnet.invalid/forms/${i}" \
      --arg author_public_key "$AUTHOR_PUBLIC_KEY_HEX" \
      '{data_hash: $data_hash, encrypted_form_url: $encrypted_form_url, author_public_key: $author_public_key}')
  else
    payload_json=$(jq -cn \
      --arg data_hash "sha256:forms-localnet-${i}-$(date +%s)" \
      --arg encrypted_form_url "https://localnet.invalid/forms/${i}" \
      --arg credit_grant_id "$CREDIT_GRANT_ID" \
      --arg sponsor_builder_id "$SPONSOR_BUILDER_ID" \
      --arg author_public_key "$AUTHOR_PUBLIC_KEY_HEX" \
      '{data_hash: $data_hash, encrypted_form_url: $encrypted_form_url, credit_grant_id: $credit_grant_id, sponsor_builder_id: $sponsor_builder_id, author_public_key: $author_public_key}')
  fi

  entry_json=$(cargo run -q -p citizen-wallet -- sign-entry \
    --path "$WALLET_PATH" \
    --key-id "$AUTHOR_KEY_ID" \
    --namespace "$NAMESPACE" \
    --action "$ACTION" \
    --object-id "$object_id" \
    --author "$AUTHOR_DID" \
    --payload-json "$payload_json" \
    --password "$PASSWORD")

  if ! cargo run -q -p citizen-wallet -- verify-entry \
    --entry-json "$entry_json" \
    --public-key "$AUTHOR_PUBLIC_KEY_HEX" >/dev/null 2>&1; then
    echo "error: local signature self-check failed for object_id=${object_id}." >&2
    echo "The signing key (AUTHOR_KEY_ID) and payload.author_public_key must match." >&2
    exit 1
  fi

  submit_error_log="$(mktemp)"
  if ! submit_response=$(submit_entry_payload "$entry_json" 2>"$submit_error_log"); then
    echo "error: wallet submit failed for object_id=${object_id}" >&2
    cat "$submit_error_log" >&2 || true
    rm -f "$submit_error_log"
    echo >&2
    echo "hint: verify namespace payload requirements and builder-credit policy gates." >&2
    if [[ "$DISABLE_CREDIT_GRANT" == "true" ]]; then
      echo "For forms.commitment localnet checks, payload must include: data_hash, encrypted_form_url, author_public_key, and author=forms.commitment (writer allowlist)." >&2
      echo "If API write-gating requires credits, rerun with DISABLE_CREDIT_GRANT=false (or unset) and a valid grant profile." >&2
    else
      echo "For forms.commitment localnet checks, payload must include: data_hash, encrypted_form_url, credit_grant_id, sponsor_builder_id, author_public_key, and author=forms.commitment (writer allowlist)." >&2
      echo "If your API profile enforces builder credits globally, include a valid credit_grant_id in the signed payload." >&2
    fi
    exit 1
  fi
  rm -f "$submit_error_log"

  receipt_id=$(printf '%s\n' "$submit_response" | jq -r '.receipt.receipt_id')
  if [[ -z "$receipt_id" || "$receipt_id" == "null" ]]; then
    echo "error: missing receipt_id in submit response" >&2
    printf '%s\n' "$submit_response" | jq . >&2 || true
    exit 1
  fi

  object_ids+=("$object_id")
  receipt_ids+=("$receipt_id")
  echo "  [ok] object_id=$object_id receipt_id=$receipt_id"
done

echo
echo "[3/6] fetch finality proofs from alpha and infer active voting participants"
participants_file="$(mktemp)"
for receipt_id in "${receipt_ids[@]}"; do
  curl -fsS "http://127.0.0.1:8081/api/v1/receipts/${receipt_id}" \
    | jq -r '.receipt.finality.commit_proof.participant_ids[]' >>"$participants_file"

  curl -fsS "http://127.0.0.1:8081/api/v1/receipts/${receipt_id}" \
    | jq '{receipt_id: .receipt.receipt_id, status: .receipt.status, block_height: .receipt.finality.block_height, participants: .receipt.finality.commit_proof.participant_ids}'
done

echo
echo "[4/6] prove receipt/block-height convergence on all 5 nodes"
for receipt_id in "${receipt_ids[@]}"; do
  echo "-- receipt ${receipt_id} --"
  heights=()
  for port in "${PORTS[@]}"; do
    line="$(curl -fsS "http://127.0.0.1:${port}/api/v1/receipts/${receipt_id}" | jq -r '[.receipt.status, (.receipt.finality.block_height|tostring)] | @tsv')"
    status="${line%%$'\t'*}"
    height="${line##*$'\t'}"
    heights+=("$height")
    echo "  ${port}: status=${status} block_height=${height}"
    if [[ "$status" != "accepted" ]]; then
      echo "error: receipt ${receipt_id} status on ${port} is ${status}, expected accepted" >&2
      rm -f "$participants_file"
      exit 1
    fi
  done

  baseline="${heights[0]}"
  for h in "${heights[@]}"; do
    if [[ "$h" != "$baseline" ]]; then
      echo "error: block height mismatch for receipt ${receipt_id}: ${heights[*]}" >&2
      rm -f "$participants_file"
      exit 1
    fi
  done
done

echo
echo "[5/6] prove entry replication for submitted object_ids across all 5 nodes"
for object_id in "${object_ids[@]}"; do
  echo "-- object ${object_id} --"
  for port in "${PORTS[@]}"; do
    count="$(curl -fsS "http://127.0.0.1:${port}/entries/${NAMESPACE}" | jq --arg oid "$object_id" '.entries // . | map(select(.object_id == $oid)) | length')"
    echo "  ${port}: matches=${count}"
    if [[ "$count" -lt 1 ]]; then
      echo "error: object ${object_id} not replicated to node on port ${port}" >&2
      rm -f "$participants_file"
      exit 1
    fi
  done
done

echo
echo "[6/6] inferred validator role summary"
active_ids="$(sort -u "$participants_file")"
rm -f "$participants_file"

echo "active_voters (seen in commit proofs):"
printf '%s\n' "$active_ids" | sed '/^$/d' | sed 's/^/  - /'

active_count="$(printf '%s\n' "$active_ids" | sed '/^$/d' | wc -l | tr -d ' ')"
if [[ "$active_count" -lt 3 ]]; then
  echo "error: expected at least 3 active voters, observed ${active_count}" >&2
  exit 1
fi

echo "standby_syncing (healthy + replicated but not observed voting in sampled commits):"
for validator in "${VALIDATORS[@]}"; do
  if ! printf '%s\n' "$active_ids" | grep -qx "$validator"; then
    echo "  - ${validator}"
  fi
done

echo
echo "done: 5-node health, finality convergence, replication, and role inference checks completed"
