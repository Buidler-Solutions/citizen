#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[stack-smoke] missing required command: $1" >&2
    exit 1
  fi
}

require_cmd curl

NODE_URL="${NODE_URL:-http://127.0.0.1:8081}"
DEMO_URL="${DEMO_URL:-http://localhost:4300}"
EXPLORER_API_URL="${EXPLORER_API_URL:-http://127.0.0.1:4010}"
EXPLORER_UI_URL="${EXPLORER_UI_URL:-http://127.0.0.1:4020}"

probe_json() {
  local label="$1"
  local url="$2"

  echo "[stack-smoke] $label -> $url"
  curl --fail --silent --show-error "$url" >/dev/null
}

probe_json "node health" "$NODE_URL/health"
probe_json "node block 0" "$NODE_URL/blocks/0"
probe_json "node namespaces" "$NODE_URL/namespaces"

probe_json "demo health" "$DEMO_URL/api/health"
probe_json "demo chain" "$DEMO_URL/api/chain"

probe_json "explorer backend health" "$EXPLORER_API_URL/health"
probe_json "explorer backend status" "$EXPLORER_API_URL/status"
probe_json "explorer backend block proxy" "$EXPLORER_API_URL/blocks/0"
probe_json "explorer backend entries proxy" "$EXPLORER_API_URL/entries/content.article"

# UI liveness check (HTML response is enough).
probe_json "explorer frontend" "$EXPLORER_UI_URL"

if [[ ! -f "wallet/browser/dist/manifest.json" ]]; then
  echo "[stack-smoke] missing wallet/browser/dist/manifest.json; run wallet/browser build first" >&2
  exit 1
fi

echo "[stack-smoke] wallet dist manifest found"
echo "[stack-smoke] all stack checks passed"
