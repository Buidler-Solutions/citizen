#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ok() {
  echo "[wallet-runtime-preflight] ✅ $1"
}

fail() {
  echo "[wallet-runtime-preflight] ❌ $1" >&2
  exit 1
}

require_cmd() {
  local cmd="$1"
  if command -v "$cmd" >/dev/null 2>&1; then
    ok "command available: $cmd"
  else
    fail "missing required command: $cmd"
  fi
}

echo "[wallet-runtime-preflight] validating toolchain commands"
require_cmd cargo
require_cmd node
require_cmd npm
require_cmd pnpm
require_cmd curl
require_cmd python3

CONFIG_DIR="config/localnet"
FILES=(
  "$CONFIG_DIR/validator-alpha.toml"
  "$CONFIG_DIR/validator-beta.toml"
  "$CONFIG_DIR/validator-gamma.toml"
)

echo "[wallet-runtime-preflight] validating localnet validator config files"
for file in "${FILES[@]}"; do
  [[ -f "$file" ]] || fail "missing config file: $file"
  ok "found config file: $file"
done

python3 <<'PY'
from __future__ import annotations

import pathlib
import tomllib

root = pathlib.Path('.').resolve()
config_dir = root / 'config' / 'localnet'
files = [
    config_dir / 'validator-alpha.toml',
    config_dir / 'validator-beta.toml',
    config_dir / 'validator-gamma.toml',
]

expected_api_ports = {8081, 8082, 8083}
expected_peer_ports = {9100, 9101, 9102}
expected_ids = {'validator-alpha', 'validator-beta', 'validator-gamma'}

configs: list[dict] = []
for file in files:
    with file.open('rb') as f:
        cfg = tomllib.load(f)
        cfg['_file'] = str(file.relative_to(root))
        configs.append(cfg)

def fail(msg: str) -> None:
    print(f"[wallet-runtime-preflight] ❌ {msg}")
    raise SystemExit(1)

def ok(msg: str) -> None:
    print(f"[wallet-runtime-preflight] ✅ {msg}")

validator_ids = {cfg.get('validator_id') for cfg in configs}
if validator_ids != expected_ids:
    fail(f"validator_id set mismatch: expected {sorted(expected_ids)}, got {sorted(validator_ids)}")
ok(f"validator_id set is correct: {sorted(expected_ids)}")

api_ports = [cfg.get('api_port') for cfg in configs]
if set(api_ports) != expected_api_ports or len(set(api_ports)) != len(api_ports):
    fail(f"api_port mismatch/duplication: expected {sorted(expected_api_ports)}, got {sorted(api_ports)}")
ok(f"api ports are unique and expected: {sorted(expected_api_ports)}")

bind_ports = []
for cfg in configs:
    bind = cfg.get('bind_addr', '')
    try:
        bind_ports.append(int(str(bind).rsplit(':', 1)[1]))
    except Exception:
        fail(f"invalid bind_addr in {cfg['_file']}: {bind!r}")

if set(bind_ports) != expected_peer_ports or len(set(bind_ports)) != len(bind_ports):
    fail(f"bind_addr peer port mismatch/duplication: expected {sorted(expected_peer_ports)}, got {sorted(bind_ports)}")
ok(f"peer QUIC ports are unique and expected: {sorted(expected_peer_ports)}")

for cfg in configs:
    file = cfg['_file']
    validator_id = cfg.get('validator_id')

    if not cfg.get('signing_key_hex'):
        fail(f"{file} missing signing_key_hex")
    ok(f"{file} has signing_key_hex")

    namespaces = cfg.get('namespaces', [])
    has_content_article = any(
        isinstance(ns, dict) and isinstance(ns.get('descriptor'), dict) and ns['descriptor'].get('namespace') == 'content.article'
        for ns in namespaces
    )
    if not has_content_article:
        fail(f"{file} missing content.article namespace bootstrap")
    ok(f"{file} includes content.article namespace")

    listed_validators = {
        entry.get('validator_id')
        for entry in cfg.get('validators', [])
        if isinstance(entry, dict)
    }
    expected_other = expected_ids - {validator_id}
    if listed_validators != expected_other:
        fail(
            f"{file} validator allowlist mismatch: expected {sorted(expected_other)}, got {sorted(listed_validators)}"
        )
    ok(f"{file} validator allowlist includes peer validators")

    peer_validator_ids = {
        entry.get('validator_id')
        for entry in cfg.get('peers', [])
        if isinstance(entry, dict)
    }
    if peer_validator_ids != expected_other:
        fail(
            f"{file} peers mismatch: expected {sorted(expected_other)}, got {sorted(peer_validator_ids)}"
        )
    ok(f"{file} peer map includes peer validators")

print('[wallet-runtime-preflight] ✅ config readiness checks passed')
PY

echo "[wallet-runtime-preflight] done"
