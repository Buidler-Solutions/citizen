#!/usr/bin/env bash
set -euo pipefail

CONFIG_PATH="${CONFIG_PATH:-/etc/citizen/node.toml}"
NODE_BIN="${NODE_BIN:-./citizen-node}"
API_BASE_URL="${API_BASE_URL:-http://127.0.0.1:8081}"
VALIDATOR_ID="${VALIDATOR_ID:-}"
POLL_INTERVAL_SECS="${POLL_INTERVAL_SECS:-5}"
RUST_LOG_LEVEL="${RUST_LOG_LEVEL:-info}"
LOG_FILE="${LOG_FILE:-/var/log/citizen-node.log}"

if [[ -z "${VALIDATOR_ID}" ]]; then
  echo "VALIDATOR_ID is required (for example: validator.alpha)" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

if [[ ! -f "${CONFIG_PATH}" ]]; then
  echo "Config file not found: ${CONFIG_PATH}" >&2
  exit 1
fi

current_standby_only() {
  if grep -Eq '^[[:space:]]*standby_only[[:space:]]*=[[:space:]]*true[[:space:]]*$' "${CONFIG_PATH}"; then
    echo "true"
  else
    echo "false"
  fi
}

set_standby_only() {
  local next_value="$1"
  cp "${CONFIG_PATH}" "${CONFIG_PATH}.bak.$(date +%s)"
  if grep -Eq '^[[:space:]]*standby_only[[:space:]]*=' "${CONFIG_PATH}"; then
    sed -i -E "s/^[[:space:]]*standby_only[[:space:]]*=.*/standby_only = ${next_value}/" "${CONFIG_PATH}"
  else
    printf '\nstandby_only = %s\n' "${next_value}" >>"${CONFIG_PATH}"
  fi
}

desired_standby_only() {
  local response
  response="$(curl -fsS "${API_BASE_URL}/api/v1/governance/proposals")" || return 1

  jq -r --arg id "${VALIDATOR_ID}" '
    .proposals
    | map(select(.proposal_type.RotateValidators? != null))
    | sort_by(.submitted_at)
    | last?
    | if . == null then "unknown" else .proposal_type.RotateValidators.active | index($id) end
  ' <<<"${response}" | awk '{
    if ($0 == "null") print "true";
    else if ($0 == "unknown") print "unknown";
    else print "false";
  }'
}

restart_node() {
  local pids
  pids="$(pgrep -f "${NODE_BIN} ${CONFIG_PATH}" || true)"
  if [[ -n "${pids}" ]]; then
    echo "[auto-promote] stopping existing node process(es): ${pids}"
    # shellcheck disable=SC2086
    kill ${pids}
    sleep 1
  fi

  echo "[auto-promote] starting node: RUST_LOG=${RUST_LOG_LEVEL} ${NODE_BIN} ${CONFIG_PATH}"
  RUST_LOG="${RUST_LOG_LEVEL}" nohup "${NODE_BIN}" "${CONFIG_PATH}" >>"${LOG_FILE}" 2>&1 &
}

echo "[auto-promote] watching validator '${VALIDATOR_ID}' via ${API_BASE_URL}/api/v1/governance/proposals"
while true; do
  desired="$(desired_standby_only || true)"
  if [[ "${desired}" == "unknown" ]]; then
    sleep "${POLL_INTERVAL_SECS}"
    continue
  fi

  current="$(current_standby_only)"
  if [[ "${current}" != "${desired}" ]]; then
    echo "[auto-promote] role change detected; updating standby_only from ${current} to ${desired} and restarting"
    set_standby_only "${desired}"
    restart_node
    echo "[auto-promote] role sync completed"
  fi
  sleep "${POLL_INTERVAL_SECS}"
done
