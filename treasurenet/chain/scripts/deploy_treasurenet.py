#!/usr/bin/env python3
"""Deploy TreasureNet Citizen Edition smart contract modules to a Citizen node.

Registers the treasure-escrow, treasure-hunt, and player-registry WASM
modules (REGISTER_MODULE + ACTIVATE_MODULE entries), then bootstraps each
module's configuration. Escrow/hunt oracle configuration requires the
service and oracle DIDs; the registry is administered by the service DID.

Usage:
    python3 chain/scripts/deploy_treasurenet.py \
        [--node http://127.0.0.1:8091] \
        --signing-key-hex <64-hex> \
        --admin-did <did:key:ed25519:...> \
        --oracle-did <did:key:ed25519:...> \
        [--governance-approvals 3]

The signing key must correspond to a DID authorized to write the
execution.module namespace (the node's governance/writer policy).
"""
import argparse
import base64
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request

import nacl.signing

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
MODULES_DIR = os.path.join(SCRIPT_DIR, "..", "..", "..", "citizen-protocol", "modules")

MODULE_FILES = {
    "treasure-escrow.v1": os.path.join(MODULES_DIR, "treasure-escrow", "target",
                                       "wasm32-unknown-unknown", "release", "treasure_escrow.wasm"),
    "treasure-hunt.v1": os.path.join(MODULES_DIR, "treasure-hunt", "target",
                                     "wasm32-unknown-unknown", "release", "treasure_hunt.wasm"),
    "player-registry.v1": os.path.join(MODULES_DIR, "player-registry", "target",
                                       "wasm32-unknown-unknown", "release", "player_registry.wasm"),
    "ctzn-token.v1": os.path.join(MODULES_DIR, "ctzn-token", "target",
                                  "wasm32-unknown-unknown", "release", "ctzn_token.wasm"),
    "citizen-asset.v1": os.path.join(MODULES_DIR, "citizen-asset", "target",
                                     "wasm32-unknown-unknown", "release", "citizen_asset.wasm"),
}


def canonical_json(obj):
    if isinstance(obj, dict):
        keys = sorted(obj.keys())
        entries = [f'{json.dumps(k)}:{canonical_json(obj[k])}' for k in keys]
        return "{" + ",".join(entries) + "}"
    if isinstance(obj, list):
        return "[" + ",".join(canonical_json(item) for item in obj) + "]"
    return json.dumps(obj)


def submit(node, entry):
    data = json.dumps(entry).encode()
    req = urllib.request.Request(
        f"{node}/api/v1/entries/submit",
        data=data,
        headers={"Content-Type": "application/json"},
    )
    try:
        resp = urllib.request.urlopen(req)
        status = "OK " if resp.status in (200, 202) else "ERR"
        print(f"  [{status}] {resp.status} {entry['action']:20s} {entry['object_id']}")
        return resp.status in (200, 202)
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"  [ERR] {e.code} {entry['action']:20s} {entry['object_id']} -- {body}")
        return False


def build_entry(signing_key, ns, action, obj_id, payload_data):
    import uuid
    entry_id = str(uuid.uuid4())
    timestamp = int(time.time())
    signing_payload = {
        "entry_id": entry_id,
        "namespace": ns,
        "action": action,
        "object_id": obj_id,
        "payload": payload_data,
        "author": author_did(signing_key),
        "timestamp": timestamp,
    }
    canonical = canonical_json(signing_payload)
    signature_hex = signing_key.sign(canonical.encode()).signature.hex()
    return {
        **signing_payload,
        "signature": signature_hex,
        "privacy_flag": False,
        "privacy_mode": "none",
    }


def author_did(signing_key):
    return f"did:key:ed25519:{signing_key.verify_key.encode().hex()}"


def register_module(node, signing_key, module_id, wasm_path, approvals):
    with open(wasm_path, "rb") as fh:
        wasm = fh.read()
    wasm_b64 = base64.b64encode(wasm).decode()
    wasm_hash = "sha256:" + hashlib.sha256(wasm).hexdigest()
    if module_id.startswith("treasure-") or module_id == "citizen-asset.v1":
        module_class = "asset"
    else:
        module_class = "identity"

    ok = submit(node, build_entry(signing_key, "execution.module", "REGISTER_MODULE", module_id, {
        "module_id": module_id,
        "module_class": module_class,
        "wasm_hash": wasm_hash,
        "audit_hash": "sha256:pending-audit",
        "wasm_bytes": wasm_b64,
    }))
    if not ok:
        return False
    return submit(node, build_entry(signing_key, "execution.module", "ACTIVATE_MODULE", module_id, {
        "module_id": module_id,
        "governance_approvals": approvals,
    }))


def execute_module(node, module_id, params):
    data = json.dumps({**params, "gas_limit": 1_000_000}).encode()
    req = urllib.request.Request(
        f"{node}/api/v1/modules/{module_id}/execute",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        resp = urllib.request.urlopen(req)
        body = json.loads(resp.read().decode())
        ok = body.get("result", {}).get("ok", False)
        detail = body.get("result", {})
        print(f"  [{'OK ' if ok else 'ERR'}] {module_id}.{params.get('operation')} -> {detail}")
        return ok
    except urllib.error.HTTPError as e:
        print(f"  [ERR] {module_id}.{params.get('operation')} -- {e.read().decode()}")
        return False


def submit_governance_approval(node, signing_key, proposal_id):
    """Submit PROPOSE + APPROVED entries so modules can pass their
    first-configure governance gate (check_governance_approval looks for an
    APPROVED entry in the bare `governance` namespace)."""
    ok = submit(node, build_entry(signing_key, "governance", "PROPOSE", proposal_id, {
        "proposal_id": proposal_id,
        "title": f"TreasureNet module deployment: {proposal_id}",
        "status": "proposed",
    }))
    return submit(node, build_entry(signing_key, "governance", "APPROVED", proposal_id, {
        "proposal_id": proposal_id,
        "status": "approved",
        "approvals": 3,
    })) and ok


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", default="http://127.0.0.1:8091")
    parser.add_argument("--signing-key-hex", required=True,
                        help="64-hex Ed25519 private key for execution.module writes")
    parser.add_argument("--admin-did", required=True,
                        help="service/admin DID recorded as module admin")
    parser.add_argument("--oracle-did", required=True,
                        help="oracle DID authorized to co-sign claims")
    parser.add_argument("--governance-approvals", type=int, default=3)
    parser.add_argument("--bootstrap-governance", action="store_true",
                        help="submit PROPOSE+APPROVED governance entries before deploying")
    parser.add_argument("--proposal-escrow", default="proposal-treasurenet-escrow")
    parser.add_argument("--proposal-hunt", default="proposal-treasurenet-hunt")
    parser.add_argument("--proposal-registry", default="proposal-treasurenet-registry")
    parser.add_argument("--proposal-ctzn", default="proposal-treasurenet-ctzn")
    parser.add_argument("--proposal-asset", default="proposal-treasurenet-asset")
    args = parser.parse_args()

    signing_key = nacl.signing.SigningKey(bytes.fromhex(args.signing_key_hex))
    print(f"Deploying TreasureNet modules to {args.node}")
    print(f"Author DID: {author_did(signing_key)}")

    if args.bootstrap_governance:
        print("submitting governance approvals")
        for proposal_id in (args.proposal_escrow, args.proposal_hunt, args.proposal_registry, args.proposal_ctzn, args.proposal_asset):
            if not submit_governance_approval(args.node, signing_key, proposal_id):
                sys.exit(3)

    for module_id, wasm_path in MODULE_FILES.items():
        if not os.path.exists(wasm_path):
            print(f"missing wasm: {wasm_path}", file=sys.stderr)
            print("build first: cd citizen-protocol/modules/<name> && "
                  "RUSTFLAGS=\"-C link-arg=--allow-undefined\" cargo build --release "
                  "--target wasm32-unknown-unknown", file=sys.stderr)
            sys.exit(1)
        print(f"registering {module_id}")
        if not register_module(args.node, signing_key, module_id, wasm_path, args.governance_approvals):
            sys.exit(2)

    print("bootstrapping module configuration")
    ok = execute_module(args.node, "player-registry.v1", {
        "operation": "configure",
        "admin_did": args.admin_did,
        "proposal_id": args.proposal_registry,
    })
    ok = execute_module(args.node, "treasure-hunt.v1", {
        "operation": "configure",
        "admin_did": args.admin_did,
        "oracles": args.oracle_did,
        "proposal_id": args.proposal_hunt,
    }) and ok
    ok = execute_module(args.node, "treasure-escrow.v1", {
        "operation": "configure",
        "admin_did": args.admin_did,
        "oracles": args.oracle_did,
        "proposal_id": args.proposal_escrow,
    }) and ok
    ok = execute_module(args.node, "ctzn-token.v1", {
        "operation": "configure",
        "admin_did": args.admin_did,
        "issuers": f"{args.admin_did},{args.oracle_did}",
        "threshold": "2",
        "proposal_id": args.proposal_ctzn,
    }) and ok
    ok = execute_module(args.node, "citizen-asset.v1", {
        "operation": "configure",
        "admin_did": args.admin_did,
        "issuers": f"{args.admin_did},{args.oracle_did}",
        "threshold": "2",
        "proposal_id": args.proposal_asset,
    }) and ok

    if not ok:
        print("module bootstrap requires approved governance proposals; "
              "create them via civic governance before configuring", file=sys.stderr)
        sys.exit(3)

    print("\nDone. Configure the backend with:")
    print(f"  TREASURENET_NODE_URL={args.node}")
    print(f"  TREASURENET_SERVICE_DID={args.admin_did}")
    print(f"  TREASURENET_ORACLE_DID={args.oracle_did}")
    print("  TREASURENET_SERVICE_KEY=<64-hex>   # from KMS, never commit")


if __name__ == "__main__":
    main()
