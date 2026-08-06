# Hello World

This tutorial walks through building, deploying, and invoking a complete smart contract. You'll create a **counter contract** that increments and reads a number on-chain.

## Step 1: Create the project

```bash
cargo new --lib counter
cd counter
```

## Step 2: Configure `Cargo.toml`

```toml
[package]
name = "counter"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]
name = "counter"

[dependencies]
citizen-contract-sdk = { path = "path/to/citizen-protocol/crates/contract-sdk" }
citizen-contract-derive = { path = "path/to/citizen-protocol/crates/contract-derive" }
serde = { version = "1", default-features = false, features = ["derive", "alloc"] }
serde_json = { version = "1", default-features = false, features = ["alloc"] }

[profile.release]
opt-level = "s"
lto = true
strip = "none"

[workspace]
```

!!! note "Why `[workspace]`?"
    The `[workspace]` declaration at the bottom prevents Cargo from trying to resolve this crate as part of the Citizen Protocol workspace. Each contract is self-contained.

## Step 3: Write the contract

Replace `src/lib.rs` with:

```rust
#![no_std]
#![no_main]

extern crate alloc;

#[global_allocator]
static ALLOC: citizen_contract_sdk::Allocator = citizen_contract_sdk::Allocator;

use citizen_contract_sdk::prelude::*;
use citizen_contract_derive::contract;

#[contract]
mod contract {
    use super::*;

    /// Increment the counter by 1.
    pub fn increment(ctx: Context) -> Result<Response> {
        let counter = ctx.storage().item::<u64>("count");
        let new_val = counter.update(|v| v + 1)?;
        ctx.emit("Incremented", &json!({"value": new_val}));
        Ok(Response::data(json!({"count": new_val})))
    }

    /// Increment by a custom amount.
    pub fn increment_by(ctx: Context) -> Result<Response> {
        let amount: u64 = ctx.param("amount")?;
        let counter = ctx.storage().item::<u64>("count");
        let new_val = counter.update(|v| v + amount)?;
        ctx.emit("Incremented", &json!({"value": new_val, "by": amount}));
        Ok(Response::data(json!({"count": new_val})))
    }

    /// Reset the counter to zero.
    pub fn reset(ctx: Context) -> Result<Response> {
        ctx.storage().item::<u64>("count").save(&0)?;
        ctx.emit("Reset", &json!({}));
        Ok(Response::success())
    }

    /// Read the current count.
    pub fn get_count(ctx: Context) -> Result<Response> {
        let count: u64 = ctx.storage().item::<u64>("count").load()?.unwrap_or(0);
        Ok(Response::data(json!({"count": count})))
    }
}
```

### What's happening here?

1. `#![no_std]` — No Rust standard library. Contracts run in a WASM sandbox.
2. `#[global_allocator]` — Wires `Vec`, `String` to the SDK's bump allocator.
3. `#[contract] mod contract { ... }` — Every `pub fn` inside becomes a callable operation.
4. `ctx.storage().item::<u64>("count")` — Typed storage slot (Solidity state variable).
5. `counter.update(|v| v + 1)?` — Read-modify-write with automatic error propagation.
6. `ctx.emit(...)` — Emits an event visible in logs and receipts.

## Step 4: Build to WASM

```bash
RUSTFLAGS="-C link-arg=--allow-undefined" cargo build --release --target wasm32-unknown-unknown
```

Output:

```
target/wasm32-unknown-unknown/release/counter.wasm
```

## Step 5: Register on-chain

Contracts must be registered (uploaded) and activated (governance-approved) before they can execute. For local development:

```python
# register_contract.py
import json, time, uuid, hashlib, base64, urllib.request
import nacl.signing, nacl.encoding

BASE = "http://127.0.0.1:8091"
GOV_SEED = b"citizen-gov-bootstrap-key-32b!!!"
gov_key = nacl.signing.SigningKey(GOV_SEED)
gov_pub = gov_key.verify_key.encode(encoder=nacl.encoding.RawEncoder)
GOV_DID = f"did:key:ed25519:{gov_pub.hex()}"

MODULE_ID = "counter"
PROPOSAL_ID = f"proposal-counter-{int(time.time())}"

# Load WASM
with open("target/wasm32-unknown-unknown/release/counter.wasm", "rb") as f:
    wasm_bytes = f.read()
wasm_b64 = base64.b64encode(wasm_bytes).decode()
wasm_hash = hashlib.sha256(wasm_bytes).hexdigest()
audit_hash = hashlib.sha256(b"counter-v1").hexdigest()

def submit(ns, action, obj_id, payload):
    entry_id = str(uuid.uuid4())
    ts = int(time.time())
    signing_payload = {"entry_id": entry_id, "namespace": ns, "action": action,
                       "object_id": obj_id, "payload": payload, "author": GOV_DID, "timestamp": ts}
    import json as j
    canonical = j.dumps(signing_payload, sort_keys=True, separators=(",", ":"))
    sig = gov_key.sign(canonical.encode()).signature.hex()
    entry = {**signing_payload, "signature": sig, "privacy_flag": False, "privacy_mode": "none"}
    req = urllib.request.Request(f"{BASE}/api/v1/entries/submit",
        data=j.dumps(entry).encode(), headers={"Content-Type": "application/json"})
    urllib.request.urlopen(req)
    print(f"  Submitted: {action} {obj_id}")

# 1. Governance approval
submit("governance", "PROPOSE", PROPOSAL_ID, {"title": "Deploy counter", "module_id": MODULE_ID})
submit("governance", "APPROVED", PROPOSAL_ID, {"proposal_id": PROPOSAL_ID})

# 2. Register module
submit("execution.module", "REGISTER_MODULE", MODULE_ID, {
    "module_id": MODULE_ID, "module_class": "governance",
    "wasm_hash": wasm_hash, "audit_hash": audit_hash, "wasm_bytes": wasm_b64,
})

# 3. Activate module
submit("execution.module", "ACTIVATE_MODULE", MODULE_ID, {
    "module_id": MODULE_ID, "governance_approvals": 1, "proposal_id": PROPOSAL_ID,
})

print(f"\nContract '{MODULE_ID}' registered and activated!")
```

## Step 6: Invoke the contract

```bash
# Increment
curl -X POST http://127.0.0.1:8091/api/v1/modules/counter/execute \
  -H "Content-Type: application/json" \
  -d '{"operation": "increment"}'

# Response: {"module_id":"counter","success":true,"result":{"count":1},"gas_consumed":...}

# Increment by 5
curl -X POST http://127.0.0.1:8091/api/v1/modules/counter/execute \
  -H "Content-Type: application/json" \
  -d '{"operation": "increment_by", "amount": 5}'

# Read the count
curl -X POST http://127.0.0.1:8091/api/v1/modules/counter/execute \
  -H "Content-Type: application/json" \
  -d '{"operation": "get_count"}'

# Reset
curl -X POST http://127.0.0.1:8091/api/v1/modules/counter/execute \
  -H "Content-Type: application/json" \
  -d '{"operation": "reset"}'
```

## Anatomy of a contract operation

When the node receives a module execution request, it:

1. Looks up the WASM bytecode from the `execution.module` namespace
2. Instantiates the module in wasmtime with gas metering
3. Calls `alloc()` to get a memory region, writes the JSON params there
4. Calls `handle(params_ptr, params_len)` — the auto-generated dispatcher
5. The dispatcher reads `operation` from the JSON and routes to your function
6. Your function receives a `Context`, does work, returns `Result<Response>`
7. The runtime reads the response bytes from the packed return value
8. Gas consumed is reported in the API response

```
POST body: {"operation": "increment_by", "amount": 5}
                          │                │
                          ▼                ▼
              #[contract] dispatcher   ctx.param("amount")?
                          │
                    pub fn increment_by(ctx)
                          │
              ctx.storage().item::<u64>("count").update(|v| v + 5)
                          │
                    Ok(Response::data(json!({"count": 5})))
                          │
              {"success":true,"result":{"count":5},"gas_consumed":N}
```

## Next steps

- [Project Structure](project-structure.md) — Deep dive into Cargo.toml and file layout
- [Storage](storage.md) — Learn about `Item<T>` and `Map<K,V>`
- [Authorization](authorization.md) — Add signature requirements
