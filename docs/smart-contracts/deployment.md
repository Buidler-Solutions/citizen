# Deployment

Contracts must be **registered** (bytecode uploaded) and **activated** (governance approved) before they can execute. This page covers the full deployment lifecycle.

## Deployment lifecycle

```
Build WASM ──► Register Module ──► Activate Module ──► Execute
   │                  │                   │                │
   │                  │                   │                │
  cargo build   execution.module    execution.module   POST /api/v1/modules/:id/execute
                REGISTER_MODULE     ACTIVATE_MODULE
```

## Step 1: Build the WASM binary

```bash
RUSTFLAGS="-C link-arg=--allow-undefined" cargo build --release --target wasm32-unknown-unknown
```

Output: `target/wasm32-unknown-unknown/release/your_contract.wasm`

## Step 2: Submit governance approval

Before a module can be activated, a governance proposal must be submitted and approved:

```python
import json, uuid, time, urllib.request
import nacl.signing, nacl.encoding

BASE = "http://127.0.0.1:8091"
GOV_SEED = b"citizen-gov-bootstrap-key-32b!!!"
gov_key = nacl.signing.SigningKey(GOV_SEED)
gov_pub = gov_key.verify_key.encode(encoder=nacl.encoding.RawEncoder)
GOV_DID = f"did:key:ed25519:{gov_pub.hex()}"

def canonical_json(obj):
    if isinstance(obj, dict):
        return "{" + ",".join(f'{json.dumps(k)}:{canonical_json(v)}' for k in sorted(obj)) + "}"
    elif isinstance(obj, list):
        return "[" + ",".join(canonical_json(i) for i in obj) + "]"
    return json.dumps(obj)

def submit(ns, action, obj_id, payload):
    entry_id = str(uuid.uuid4())
    ts = int(time.time())
    signing = {"entry_id": entry_id, "namespace": ns, "action": action,
               "object_id": obj_id, "payload": payload, "author": GOV_DID, "timestamp": ts}
    sig = gov_key.sign(canonical_json(signing).encode()).signature.hex()
    entry = {**signing, "signature": sig, "privacy_flag": False, "privacy_mode": "none"}
    req = urllib.request.Request(f"{BASE}/api/v1/entries/submit",
        data=json.dumps(entry).encode(), headers={"Content-Type": "application/json"})
    urllib.request.urlopen(req)
    print(f"  Submitted: {action} {obj_id}")

PROPOSAL_ID = f"proposal-deploy-{int(time.time())}"

submit("governance", "PROPOSE", PROPOSAL_ID, {
    "title": "Deploy my contract",
    "module_id": "my-contract",
    "proposed_by": GOV_DID,
})
submit("governance", "APPROVED", PROPOSAL_ID, {
    "proposal_id": PROPOSAL_ID,
    "approved_by": GOV_DID,
})
```

## Step 3: Register the module

Upload the WASM bytecode to the `execution.module` namespace:

```python
import hashlib, base64

with open("target/wasm32-unknown-unknown/release/my_contract.wasm", "rb") as f:
    wasm_bytes = f.read()

MODULE_ID = "my-contract"

submit("execution.module", "REGISTER_MODULE", MODULE_ID, {
    "module_id": MODULE_ID,
    "module_class": "governance",  # Must be in allowed_module_classes
    "wasm_hash": hashlib.sha256(wasm_bytes).hexdigest(),
    "audit_hash": hashlib.sha256(b"my-contract-v1").hexdigest(),
    "wasm_bytes": base64.b64encode(wasm_bytes).decode(),
})
```

### Registration requirements

| Field | Description |
|-------|-------------|
| `module_id` | Unique identifier (also the `object_id`) |
| `module_class` | Must be in the node's `allowed_module_classes` config |
| `wasm_hash` | SHA-256 of the WASM bytecode |
| `audit_hash` | SHA-256 of audit materials (can be any identifier) |
| `wasm_bytes` | Base64-encoded WASM bytecode |

### Allowed module classes

The triolet validator configs define which classes are allowed:

```toml
[[namespaces.validators]]
name = "wasm_runtime_policy"
config.allowed_module_classes = ["governance", "policy-guard", "deterministic-indexer", "receipt-verifier"]
config.required_governance_approvals = 1
```

## Step 4: Activate the module

```python
submit("execution.module", "ACTIVATE_MODULE", MODULE_ID, {
    "module_id": MODULE_ID,
    "governance_approvals": 1,  # Must meet required_governance_approvals
    "proposal_id": PROPOSAL_ID,
})
```

The activation check verifies that `governance_approvals >= required_governance_approvals` (configured in the node TOML, default 1).

## Step 5: Execute the contract

```bash
curl -X POST http://127.0.0.1:8091/api/v1/modules/my-contract/execute \
  -H "Content-Type: application/json" \
  -d '{"operation": "my_operation", "param": "value"}'
```

## Checking module status

```bash
curl http://127.0.0.1:8091/api/v1/modules/my-contract

# Response:
# {
#   "module_id": "my-contract",
#   "registered": true,
#   "active": true,
#   "module_class": "governance",
#   "wasm_hash": "abc123...",
#   "entries": 2
# }
```

## Upgrading a contract

Only the **original deployer** can upgrade a contract. The protocol enforces wallet ownership — the `author` field on the first `REGISTER_MODULE` entry becomes the module owner. Any subsequent `REGISTER_MODULE` or `ACTIVATE_MODULE` from a different wallet will be rejected.

To deploy a new version:

1. Build the new WASM binary
2. Submit a new `REGISTER_MODULE` entry with the same `module_id` (new `wasm_hash`) **using the same wallet that originally deployed it**
3. Submit a new `ACTIVATE_MODULE` entry (also from the original deployer)
4. The latest activation entry takes precedence

```python
# Re-register with new bytecode (MUST use original deployer's wallet)
submit("execution.module", "REGISTER_MODULE", MODULE_ID, {
    "module_id": MODULE_ID,
    "module_class": "governance",
    "wasm_hash": new_hash,
    "audit_hash": new_audit_hash,
    "wasm_bytes": new_wasm_b64,
})

# Re-activate (also from original deployer)
submit("execution.module", "ACTIVATE_MODULE", MODULE_ID, {
    "module_id": MODULE_ID,
    "governance_approvals": 1,
    "proposal_id": new_proposal_id,
})
```

!!! danger "Wallet ownership enforced"
    Smart contracts are owned by the wallet that deployed them. No other wallet can modify, upgrade, or activate the contract. This is enforced at the protocol level — not in contract code.

!!! warning "State persistence"
    Upgrading a module does NOT clear its state. Previous `host_store_state` entries persist. Design your storage schema with backward-compatible serde defaults.

## Complete deployment script

See `citizen-protocol/scripts/register_admin_contract.py` for a complete, working deployment script that handles all 4 steps.

## Next steps

- [Testing](testing.md) — Test contracts locally
- [Best Practices](best-practices.md) — Security and gas optimization
