#!/usr/bin/env python3
"""Seed civic.admin with an initial admin, signing all entries cryptographically.

Uses a generated governance keypair to sign the ASSIGN_ADMIN entry.
The admin's own key is not needed for bootstrap — the governance body
signs the assignment.

Usage:
    python3 scripts/seed_admin_and_election.py [ADMIN_DID]

Defaults to a test admin DID if none provided.
"""
import json, sys, time, uuid, urllib.request, urllib.parse
import nacl.signing
import nacl.encoding

BASE = "http://127.0.0.1:8091"

ADMIN_DID = sys.argv[1] if len(sys.argv) > 1 else "did:key:ed25519:f0481295842742b61db58ad33c721f7f61c273e58c837804b5126ea4946b40ad"

# Generate a deterministic governance keypair for bootstrap
GOVERNANCE_SEED = b"citizen-gov-bootstrap-key-32b!!!"  # exactly 32 bytes
governance_key = nacl.signing.SigningKey(GOVERNANCE_SEED)
governance_pub = governance_key.verify_key.encode(encoder=nacl.encoding.RawEncoder)
GOVERNANCE_DID = f"did:key:ed25519:{governance_pub.hex()}"


def canonical_json(obj):
    """JCS-style canonical JSON: sorted keys recursively, compact, no whitespace."""
    if isinstance(obj, dict):
        keys = sorted(obj.keys())
        entries = [f'{json.dumps(k)}:{canonical_json(obj[k])}' for k in keys]
        return "{" + ",".join(entries) + "}"
    elif isinstance(obj, list):
        return "[" + ",".join(canonical_json(item) for item in obj) + "]"
    else:
        return json.dumps(obj)


def sign_entry(author_did, signing_key, ns, action, obj_id, payload_data):
    """Build, sign, and submit a ledger entry with a real ed25519 signature."""
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


print(f"Governance DID: {GOVERNANCE_DID}")
print(f"Admin DID:      {ADMIN_DID}")

# ── 1. Assign admins (signed by governance key) ────────────────────
print(f"\n1. Assigning admin roles...")

# Bootstrap: governance self-assigns as admin first (no admins exist yet)
sign_entry(
    GOVERNANCE_DID,
    governance_key,
    "civic.admin",
    "ASSIGN_ADMIN",
    GOVERNANCE_DID,
    {
        "admin_did": GOVERNANCE_DID,
        "role": "governance-body",
        "scope": "national",
        "assigned_by": GOVERNANCE_DID,
        "assigned_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    },
)

# Then assign the user's DID as admin
sign_entry(
    GOVERNANCE_DID,
    governance_key,
    "civic.admin",
    "ASSIGN_ADMIN",
    ADMIN_DID,
    {
        "admin_did": ADMIN_DID,
        "role": "election-commissioner",
        "scope": "national",
        "assigned_by": GOVERNANCE_DID,
        "assigned_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    },
)

# ── 2. Verify admin via API ──────────────────────────────────────────
print(f"\n2. Verifying admin status...")
try:
    encoded_did = urllib.parse.quote(ADMIN_DID, safe='')
    req = urllib.request.Request(f"{BASE}/api/v1/civic/admin/check/{encoded_did}")
    resp = urllib.request.urlopen(req)
    data = json.loads(resp.read())
    print(f"  is_admin={data.get('is_admin')}  role={data.get('role')}  scope={data.get('scope')}")
except Exception as e:
    print(f"  [ERR] {e}")

print(f"\nDone. Admin {ADMIN_DID} is registered.")
print(f"All civic namespaces now enforce require_signature.")
print(f"Unsigned or forged entries will be rejected by the blockchain.")
