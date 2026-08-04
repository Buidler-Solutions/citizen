#!/usr/bin/env python3
"""Seed CTZN token data on the triolet for frontend testing."""
import json, time, uuid, urllib.request

BASE = "http://127.0.0.1:8091"
MODULE_ID = "ctzn-token.v1"

def submit(payload):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"{BASE}/api/v1/entries/submit",
        data=data,
        headers={"Content-Type": "application/json"},
    )
    resp = urllib.request.urlopen(req)
    print(f"  {resp.status} {payload['action']:20s} {payload['object_id']}")
    return resp

def entry(ns, action, obj_id, payload_data, author="governance:vote"):
    return {
        "entry_id": str(uuid.uuid4()),
        "namespace": ns,
        "action": action,
        "object_id": obj_id,
        "payload": payload_data,
        "author": author,
        "signature": "placeholder",
        "timestamp": int(time.time()),
        "privacy_flag": False,
        "privacy_mode": "none",
    }

print("Registering CTZN token module...")
submit(entry("execution.module", "REGISTER_MODULE", MODULE_ID, {
    "module_id": MODULE_ID,
    "module_class": "identity",
    "wasm_hash": "sha256:placeholder-hash",
    "audit_hash": "sha256:placeholder-audit",
    "wasm_bytes": "AGFzbQ==",
}))

print("Activating module...")
submit(entry("execution.module", "ACTIVATE_MODULE", MODULE_ID, {
    "module_id": MODULE_ID,
    "governance_approvals": 3,
}))

citizens = [
    ("did:citizen:alice", "tok-001", "citizenship", "2"),
    ("did:citizen:bob",   "tok-002", "citizenship", "2"),
    ("did:citizen:carol", "tok-003", "citizenship", "1"),
    ("did:citizen:dave",  "tok-004", "citizenship", "3"),
    ("did:citizen:eve",   "tok-005", "citizenship", "2"),
]

print("Minting tokens...")
for did, tid, schema, tier in citizens:
    submit(entry("execution.module", "STATE_WRITE", MODULE_ID, {
        "module_id": MODULE_ID,
        "state_key": f"owner:{tid}",
        "state_value": did,
    }))
    submit(entry("execution.module", "STATE_WRITE", MODULE_ID, {
        "module_id": MODULE_ID,
        "state_key": f"owner_lookup:{did}",
        "state_value": tid,
    }))
    submit(entry("execution.module", "STATE_WRITE", MODULE_ID, {
        "module_id": MODULE_ID,
        "state_key": f"schema:{tid}",
        "state_value": schema,
    }))
    submit(entry("execution.module", "STATE_WRITE", MODULE_ID, {
        "module_id": MODULE_ID,
        "state_key": f"tier:{tid}",
        "state_value": tier,
    }))

print("Revoking one token...")
submit(entry("execution.module", "STATE_WRITE", MODULE_ID, {
    "module_id": MODULE_ID,
    "state_key": "revoked:tok-003",
    "state_value": "true",
}))

print("\nDone! Check:")
print(f"  {BASE}/api/v1/ctzn/{MODULE_ID}/status")
print(f"  {BASE}/api/v1/ctzn/{MODULE_ID}/holders")
print(f"  {BASE}/api/v1/ctzn/{MODULE_ID}/check/did:citizen:alice")
