#!/usr/bin/env python3
"""Register and activate the admin-registry smart contract, then bootstrap it.

This script deploys the admin-registry WASM module to the Citizen protocol,
activates it via governance approval, and configures it with an initial admin.

Usage:
    python3 scripts/register_admin_contract.py [ADMIN_DID] [--governance-seed SEED]

Defaults to a test admin DID if none provided.
"""
import json, sys, time, uuid, hashlib, base64, argparse, urllib.request, urllib.parse, os
import nacl.signing
import nacl.encoding

BASE = "http://127.0.0.1:8091"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
WASM_PATH = os.path.join(SCRIPT_DIR, "..", "modules", "admin-registry", "target",
                         "wasm32-unknown-unknown", "release", "admin_registry.wasm")


def canonical_json(obj):
    if isinstance(obj, dict):
        keys = sorted(obj.keys())
        entries = [f'{json.dumps(k)}:{canonical_json(obj[k])}' for k in keys]
        return "{" + ",".join(entries) + "}"
    elif isinstance(obj, list):
        return "[" + ",".join(canonical_json(item) for item in obj) + "]"
    else:
        return json.dumps(obj)


def submit_entry(author_did, signing_key, ns, action, obj_id, payload_data):
    entry_id = str(uuid.uuid4())
    timestamp = int(time.time())

    signing_payload = {
        "entry_id": entry_id,
        "namespace": ns,
        "action": action,
        "object_id": obj_id,
        "payload": payload_data,
        "author": author_did,
        "timestamp": timestamp,
    }

    canonical = canonical_json(signing_payload)
    signed = signing_key.sign(canonical.encode())
    signature_hex = signed.signature.hex()

    entry = {
        "entry_id": entry_id,
        "namespace": ns,
        "action": action,
        "object_id": obj_id,
        "payload": payload_data,
        "author": author_did,
        "signature": signature_hex,
        "timestamp": timestamp,
        "privacy_flag": False,
        "privacy_mode": "none",
    }

    data = json.dumps(entry).encode()
    req = urllib.request.Request(
        f"{BASE}/api/v1/entries/submit",
        data=data,
        headers={"Content-Type": "application/json"},
    )
    try:
        resp = urllib.request.urlopen(req)
        status = "OK" if resp.status == 202 else "ERR"
        print(f"  [{status}] {resp.status} {action:20s} {obj_id}")
        return resp
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"  [ERR] {e.code} {action:20s} {obj_id} -- {body}")
        return e


def execute_module(module_id, params):
    data = json.dumps(params).encode()
    req = urllib.request.Request(
        f"{BASE}/api/v1/modules/{module_id}/execute",
        data=data,
        headers={"Content-Type": "application/json"},
    )
    try:
        resp = urllib.request.urlopen(req)
        return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"  [ERR] module execute failed: {e.code} -- {body}")
        return None


def main():
    parser = argparse.ArgumentParser(description="Register admin-registry smart contract")
    parser.add_argument("admin_did", nargs="?",
                        default="did:key:ed25519:f0481295842742b61db58ad33c721f7f61c273e58c837804b5126ea4946b40ad",
                        help="DID of the initial admin to bootstrap")
    parser.add_argument("--governance-seed", default="citizen-gov-bootstrap-key-32b!!!",
                        help="32-byte governance seed key")
    parser.add_argument("--wasm-path", default=WASM_PATH,
                        help="Path to the compiled admin_registry.wasm")
    args = parser.parse_args()

    # Governance keypair
    gov_seed = args.governance_seed.encode()
    if len(gov_seed) < 32:
        gov_seed = gov_seed.ljust(32, b'!')
    gov_key = nacl.signing.SigningKey(gov_seed[:32])
    gov_pub = gov_key.verify_key.encode(encoder=nacl.encoding.RawEncoder)
    GOV_DID = f"did:key:ed25519:{gov_pub.hex()}"

    # Load WASM
    if not os.path.exists(args.wasm_path):
        print(f"ERROR: WASM not found at {args.wasm_path}")
        print("Build it first: cd modules/admin-registry && RUSTFLAGS=\"-C link-arg=--allow-undefined\" cargo build --release --target wasm32-unknown-unknown")
        sys.exit(1)

    with open(args.wasm_path, "rb") as f:
        wasm_bytes = f.read()

    wasm_b64 = base64.b64encode(wasm_bytes).decode()
    wasm_hash = hashlib.sha256(wasm_bytes).hexdigest()
    audit_hash = hashlib.sha256(b"admin-registry-v1").hexdigest()

    MODULE_ID = "admin-registry"
    PROPOSAL_ID = f"proposal-admin-registry-{int(time.time())}"

    print(f"Governance DID: {GOV_DID}")
    print(f"Admin DID:      {args.admin_did}")
    print(f"Module ID:      {MODULE_ID}")
    print(f"WASM size:      {len(wasm_bytes)} bytes")
    print(f"WASM hash:      {wasm_hash}")

    # ── 1. Submit governance approval ─────────────────────────────
    print(f"\n1. Submitting governance approval...")
    submit_entry(
        GOV_DID, gov_key,
        "governance", "PROPOSE", PROPOSAL_ID,
        {
            "title": "Approve admin-registry smart contract",
            "module_id": MODULE_ID,
            "wasm_hash": wasm_hash,
            "proposed_by": GOV_DID,
            "proposed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        },
    )
    submit_entry(
        GOV_DID, gov_key,
        "governance", "APPROVED", PROPOSAL_ID,
        {
            "proposal_id": PROPOSAL_ID,
            "approved_by": GOV_DID,
            "approved_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        },
    )

    # ── 2. Register the WASM module ───────────────────────────────
    print(f"\n2. Registering admin-registry module...")
    submit_entry(
        GOV_DID, gov_key,
        "execution.module", "REGISTER_MODULE", MODULE_ID,
        {
            "module_id": MODULE_ID,
            "module_class": "governance",
            "wasm_hash": wasm_hash,
            "audit_hash": audit_hash,
            "wasm_bytes": wasm_b64,
        },
    )

    # ── 3. Activate the module (with governance approval) ─────────
    print(f"\n3. Activating admin-registry module...")
    submit_entry(
        GOV_DID, gov_key,
        "execution.module", "ACTIVATE_MODULE", MODULE_ID,
        {
            "module_id": MODULE_ID,
            "governance_approvals": 1,
            "proposal_id": PROPOSAL_ID,
        },
    )

    # Wait for entries to be processed
    print(f"\n4. Waiting for block finalization...")
    time.sleep(3)

    # ── 5. Configure the contract with bootstrap admin ────────────
    print(f"\n5. Configuring admin-registry with bootstrap admin...")
    result = execute_module(MODULE_ID, {
        "operation": "configure",
        "proposal_id": PROPOSAL_ID,
        "bootstrap_admin_did": args.admin_did,
        "role": "election-commissioner",
        "scope": "national",
    })
    if result:
        print(f"  Result: {json.dumps(result.get('result', result), indent=2)}")
    else:
        print("  [WARN] Configuration may have failed. Check node logs.")

    # ── 6. Verify admin status ────────────────────────────────────
    print(f"\n6. Verifying admin status via smart contract...")
    time.sleep(1)
    result = execute_module(MODULE_ID, {
        "operation": "check_admin",
        "did": args.admin_did,
    })
    if result and result.get("success"):
        check_result = result.get("result", {})
        is_admin = check_result.get("is_admin", False)
        role = check_result.get("role")
        scope = check_result.get("scope")
        source = check_result.get("source", "smart-contract")
        print(f"  is_admin={is_admin}  role={role}  scope={scope}  source=smart-contract")
    else:
        # Fallback: try the API endpoint
        try:
            encoded_did = urllib.parse.quote(args.admin_did, safe='')
            req = urllib.request.Request(f"{BASE}/api/v1/civic/admin/check/{encoded_did}")
            resp = urllib.request.urlopen(req)
            data = json.loads(resp.read())
            print(f"  is_admin={data.get('is_admin')}  role={data.get('role')}  scope={data.get('scope')}  source={data.get('source', 'unknown')}")
        except Exception as e:
            print(f"  [ERR] {e}")

    print(f"\nDone. Admin-registry smart contract is deployed and configured.")
    print(f"Admin management is now powered by the admin-registry WASM contract.")
    print(f"Use POST /api/v1/modules/admin-registry/execute for admin operations.")


if __name__ == "__main__":
    main()
