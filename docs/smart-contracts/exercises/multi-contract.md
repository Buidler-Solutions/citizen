# Exercise 5: Multi-Contract

Build two contracts that communicate via cross-contract calls. This exercise practices `call_module()`, composing results from multiple contracts, and handling cross-contract failures gracefully.

## Problem statement

Build a **gated registry** system with two contracts:

### Contract 1: `gate-keeper`

A simple contract that tracks whether a DID is "verified":

| Operation | Parameters | Behavior |
|-----------|-----------|----------|
| `verify` | `did` | Mark a DID as verified |
| `unverify` | `did` | Remove verification |
| `is_verified` | `did` | Return `{"verified": true/false}` |

### Contract 2: `registry`

A registry that only allows verified DIDs to register:

| Operation | Parameters | Behavior |
|-----------|-----------|----------|
| `register` | `did`, `name` | Add to registry — calls `gate-keeper.is_verified` first |
| `is_registered` | `did` | Check registration |
| `list` | — | List all registered entries |

### Architecture

```
  registry.register(did, name)
         │
         │  1. Call gate-keeper.is_verified(did)
         ▼
  ┌─────────────┐
  │ gate-keeper │ ────► {"verified": true/false}
  └─────────────┘
         │
         │  2. If verified → add to registry
         │     If not     → return error
         ▼
  registry responds
```

### Requirements

1. `registry.register` must call `gate-keeper` to verify the DID before adding
2. If the cross-contract call fails, return a clear error
3. Only verified DIDs can register
4. Maintain enumeration index for `list`
5. Emit events in both contracts
6. Handle the case where `gate-keeper` is not deployed (graceful failure)

## Starter code — Contract 1: gate-keeper

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

    // TODO: verify
    pub fn verify(ctx: Context) -> Result<Response> {
        todo!()
    }

    // TODO: unverify
    pub fn unverify(ctx: Context) -> Result<Response> {
        todo!()
    }

    // TODO: is_verified
    pub fn is_verified(ctx: Context) -> Result<Response> {
        todo!()
    }
}
```

## Starter code — Contract 2: registry

```rust
#![no_std]
#![no_main]
extern crate alloc;

#[global_allocator]
static ALLOC: citizen_contract_sdk::Allocator = citizen_contract_sdk::Allocator;

use citizen_contract_sdk::prelude::*;
use citizen_contract_derive::contract;
use serde::{Serialize, Deserialize};

#[derive(Serialize, Deserialize)]
struct RegistryEntry {
    did: String,
    name: String,
    registered_block: u64,
}

#[contract]
mod contract {
    use super::*;

    // TODO: register (calls gate-keeper first)
    pub fn register(ctx: Context) -> Result<Response> {
        todo!()
    }

    // TODO: is_registered
    pub fn is_registered(ctx: Context) -> Result<Response> {
        todo!()
    }

    // TODO: list
    pub fn list(ctx: Context) -> Result<Response> {
        todo!()
    }
}
```

## Hints

??? tip "Hint 1: gate-keeper storage"
    Use a simple key pattern: `"verified:<did>"` with value `"1"`:
    ```rust
    pub fn verify(ctx: Context) -> Result<Response> {
        let did: String = ctx.param("did")?;
        ctx.storage().set_str(&format!("verified:{did}"), "1")?;
        ctx.emit("Verified", &json!({"did": did}));
        Ok(Response::success())
    }
    ```

??? tip "Hint 2: Cross-contract call"
    ```rust
    let result = call_module("gate-keeper", &serde_json::to_string(&json!({
        "operation": "is_verified",
        "did": did
    })).unwrap_or_default());
    ```

??? tip "Hint 3: Parse the cross-contract response"
    ```rust
    let verified = result
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("verified").and_then(|x| x.as_bool()))
        .unwrap_or(false);
    ```

??? tip "Hint 4: Handle call failure"
    ```rust
    match call_module("gate-keeper", &params_json) {
        Some(response_json) => { /* parse */ }
        None => {
            return Err(ContractError::msg(
                "gate-keeper contract not available"
            ));
        }
    }
    ```

## Complete solution — Contract 1: gate-keeper

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

    pub fn verify(ctx: Context) -> Result<Response> {
        let did: String = ctx.param("did")?;
        ctx.storage().set_str(&format!("verified:{did}"), "1")?;
        ctx.emit("Verified", &json!({"did": did, "block": ctx.block_height()}));
        Ok(Response::data(json!({"verified": did})))
    }

    pub fn unverify(ctx: Context) -> Result<Response> {
        let did: String = ctx.param("did")?;
        ctx.storage().remove(&format!("verified:{did}"));
        ctx.emit("Unverified", &json!({"did": did}));
        Ok(Response::data(json!({"unverified": did})))
    }

    pub fn is_verified(ctx: Context) -> Result<Response> {
        let did: String = ctx.param("did")?;
        let verified = ctx.storage().exists(&format!("verified:{did}"));
        Ok(Response::data(json!({"verified": verified})))
    }
}
```

## Complete solution — Contract 2: registry

```rust
#![no_std]
#![no_main]
extern crate alloc;

#[global_allocator]
static ALLOC: citizen_contract_sdk::Allocator = citizen_contract_sdk::Allocator;

use citizen_contract_sdk::prelude::*;
use citizen_contract_derive::contract;
use serde::{Serialize, Deserialize};

#[derive(Serialize, Deserialize)]
struct RegistryEntry {
    did: String,
    name: String,
    registered_block: u64,
}

#[contract]
mod contract {
    use super::*;

    pub fn register(ctx: Context) -> Result<Response> {
        let did: String = ctx.param("did")?;
        let name: String = ctx.param("name")?;

        // ── Cross-contract call: verify with gate-keeper ──
        let gate_params = serde_json::to_string(&json!({
            "operation": "is_verified",
            "did": &did
        })).unwrap_or_default();

        let result = call_module("gate-keeper", &gate_params);

        let verified = match result {
            Some(response_json) => {
                let response: serde_json::Value = serde_json::from_str(&response_json)
                    .map_err(|e| ContractError::msg(&format!("invalid gate-keeper response: {e}")))?;
                response.get("verified")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
            }
            None => {
                return Err(ContractError::msg(
                    "gate-keeper contract not available"
                ));
            }
        };

        if !verified {
            return Err(ContractError::Unauthorized(
                "DID is not verified by gate-keeper".into()
            ));
        }

        // ── Check for duplicate ──
        let storage = ctx.storage();
        let entries = storage.map::<String, RegistryEntry>("entry");

        if entries.exists(&did) {
            return Err(ContractError::msg("already registered"));
        }

        // ── Register ──
        let block = ctx.block_height();
        entries.save(&did, &RegistryEntry {
            did: did.clone(),
            name: name.clone(),
            registered_block: block,
        })?;

        // Update index
        let mut list = storage.get_str("entry_list").unwrap_or_default();
        if !list.is_empty() { list.push(','); }
        list.push_str(&did);
        storage.set_str("entry_list", &list)?;

        ctx.emit("Registered", &json!({
            "did": did,
            "name": name,
            "verified_by": "gate-keeper",
            "block": block
        }));

        Ok(Response::data(json!({
            "registered": true,
            "did": did,
            "name": name
        })))
    }

    pub fn is_registered(ctx: Context) -> Result<Response> {
        let did: String = ctx.param("did")?;

        let entry = ctx.storage()
            .map::<String, RegistryEntry>("entry")
            .load(&did)?;

        Ok(Response::data(json!({
            "did": did,
            "registered": entry.is_some(),
            "entry": entry
        })))
    }

    pub fn list(ctx: Context) -> Result<Response> {
        let storage = ctx.storage();
        let list = storage.get_str("entry_list").unwrap_or_default();
        let entries = storage.map::<String, RegistryEntry>("entry");

        let mut result = Vec::new();
        for did in list.split(',') {
            if did.is_empty() { continue; }
            if let Some(entry) = entries.load(&did.to_string())? {
                result.push(json!({
                    "did": entry.did,
                    "name": entry.name,
                    "registered_block": entry.registered_block
                }));
            }
        }

        Ok(Response::data(json!({
            "entries": result,
            "count": result.len()
        })))
    }
}
```

## Test cases

```python
#!/usr/bin/env python3
"""Integration test for multi-contract exercise."""
import json, urllib.request

BASE = "http://127.0.0.1:8091"

def execute(module_id, params):
    data = json.dumps(params).encode()
    req = urllib.request.Request(
        f"{BASE}/api/v1/modules/{module_id}/execute",
        data=data, headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req).read())

ALICE = "did:key:ed25519:alice"
BOB = "did:key:ed25519:bob"

# ── Step 1: Set up gate-keeper ──

# Verify Alice
result = execute("gate-keeper", {"operation": "verify", "did": ALICE})
assert result["success"]
print("✓ Alice verified by gate-keeper")

# Check Alice is verified
result = execute("gate-keeper", {"operation": "is_verified", "did": ALICE})
assert result["result"]["verified"] is True
print("✓ gate-keeper confirms Alice is verified")

# Bob is NOT verified
result = execute("gate-keeper", {"operation": "is_verified", "did": BOB})
assert result["result"]["verified"] is False
print("✓ gate-keeper confirms Bob is NOT verified")

# ── Step 2: Test registry ──

# Alice can register (verified)
result = execute("registry", {
    "operation": "register", "did": ALICE, "name": "Alice Smith"
})
assert result["success"]
print("✓ Alice registered successfully")

# Bob cannot register (not verified)
result = execute("registry", {
    "operation": "register", "did": BOB, "name": "Bob Jones"
})
assert not result["success"]
assert "not verified" in result["result"].get("error", "").lower() or \
       "unauthorized" in result["result"].get("error", "").lower()
print("✓ Bob correctly rejected (not verified)")

# Check Alice is registered
result = execute("registry", {"operation": "is_registered", "did": ALICE})
assert result["result"]["registered"] is True
print("✓ Registry confirms Alice is registered")

# Duplicate registration fails
result = execute("registry", {
    "operation": "register", "did": ALICE, "name": "Alice Duplicate"
})
assert not result["success"]
print("✓ Duplicate registration rejected")

# ── Step 3: Verify Bob, then register ──

execute("gate-keeper", {"operation": "verify", "did": BOB})
result = execute("registry", {
    "operation": "register", "did": BOB, "name": "Bob Jones"
})
assert result["success"]
print("✓ Bob registered after verification")

# ── Step 4: List all entries ──

result = execute("registry", {"operation": "list"})
assert result["result"]["count"] == 2
print(f"✓ Listed {result['result']['count']} entries")

# ── Step 5: Unverify doesn't unregister ──

execute("gate-keeper", {"operation": "unverify", "did": ALICE})
result = execute("registry", {"operation": "is_registered", "did": ALICE})
assert result["result"]["registered"] is True  # Still registered
print("✓ Alice still registered after unverification")

print("\nAll tests passed!")
```

## Deployment note

Both contracts must be registered and activated before the integration test works:

1. Build both WASM binaries
2. Deploy `gate-keeper` (register + activate)
3. Deploy `registry` (register + activate)
4. Run the integration test

See [Deployment](../deployment.md) for the full deployment script.

## Key concepts learned

- **`call_module()`** — Cross-contract invocation with JSON params
- **Response parsing** — Extracting fields from cross-contract JSON response
- **Graceful failure** — Handling `None` when the target contract isn't deployed
- **Composition pattern** — One contract gates access, another stores data
- **Decoupled architecture** — Gate-keeper doesn't know about registry (and vice versa)
- **State isolation** — Each contract has its own scoped state namespace

## Next exercise

[Exercise 6: Auction →](auction.md)
