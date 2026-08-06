# Citizen Contract SDK

Write Citizen Protocol smart contracts in Rust with Solidity-like ergonomics. No manual JSON parsing, no pointer arithmetic, no buffer management.

## Why?

| | Raw WASM (v1) | SDK (v2) |
|---|---|---|
| **Lines of code** | 729 | 247 |
| **JSON parsing** | Hand-rolled parser (`parse_fields`) | `ctx.param::<T>()` with serde |
| **State access** | Manual `host_store_state` / `host_load_state` + buffers | `storage.map::<K,V>()` typed API |
| **Auth checks** | Manual hex encode + `host_verify_signature` | `ctx.require_signature()` / `ctx.require_governance()` |
| **Error handling** | Manual JSON error strings | `Result<T, ContractError>` with `?` |
| **Memory management** | `bump_read()`, `bump_write()`, `alloc()` | Automatic (global allocator) |
| **Dispatch** | Manual `match op { ... }` | `#[contract]` auto-generates |

## Quick Start

### 1. Create a contract crate

```bash
cargo new --lib my-contract
cd my-contract
```

### 2. Configure `Cargo.toml`

```toml
[package]
name = "my-contract"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]
name = "my_contract"

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

### 3. Write the contract

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
struct Counter {
    value: u64,
}

#[contract]
mod contract {
    use super::*;

    /// Increment the counter (execute).
    pub fn increment(ctx: Context) -> Result<Response> {
        let storage = ctx.storage();
        let item = storage.item::<u64>("count");
        let new_val = item.update(|v| v + 1)?;

        ctx.emit("Incremented", &json!({"value": new_val}));
        Ok(Response::data(json!({"count": new_val})))
    }

    /// Read the counter (query).
    pub fn get_count(ctx: Context) -> Result<Response> {
        let count: u64 = ctx.storage().item::<u64>("count").load()?.unwrap_or(0);
        Ok(Response::data(json!({"count": count})))
    }
}
```

### 4. Build to WASM

```bash
RUSTFLAGS="-C link-arg=--allow-undefined" cargo build --release --target wasm32-unknown-unknown
```

### 5. Deploy and invoke

```bash
# Register on-chain
python3 scripts/register_admin_contract.py

# Invoke via API
curl -X POST http://localhost:8091/api/v1/modules/my-contract/execute \
  -H "Content-Type: application/json" \
  -d '{"operation": "increment"}'
```

## API Reference

### Entry Points

| Pattern | Description |
|---------|-------------|
| `#[contract] mod contract { ... }` | Auto-generates `alloc`, `handle`, panic handler from all `pub fn` items |
| `entrypoint! { fn1 => "op1", fn2 => "op2" }` | Manual dispatch (alternative to `#[contract]`) |

### Context (Solidity `msg.*` equivalent)

```rust
pub fn my_op(ctx: Context) -> Result<Response> {
    // Typed params (required, optional, default)
    let did: String = ctx.param("did")?;           // Error if missing
    let role: String = ctx.param_or("role", "admin".into());  // Default
    let expiry: Option<u64> = ctx.param_opt("expiry")?;       // Optional

    // Block context
    let block = ctx.block_height();                 // block.number

    // Storage
    let storage = ctx.storage();

    // Authorization (modifiers)
    ctx.require_governance("proposal-123")?;        // require(gov approval)
    ctx.require_signature(did, msg, sig_hex)?;      // require(sig valid)
    ctx.require_exists("admin:key")?;               // require(exists)

    // Events
    ctx.emit("AdminAssigned", &json!({"did": did}));

    Ok(Response::success())
}
```

### Storage (Solidity state variables)

```rust
let storage = ctx.storage();

// Key-value (raw strings)
storage.set_str("key", "value")?;
let val = storage.get_str("key");
storage.remove("key");

// Typed single value (state variable)
let count = storage.item::<u64>("count");
count.save(&42)?;
let val = count.load()?;           // Option<u64>
count.update(|v| v + 1)?;         // Read-modify-write
count.exists();
count.remove();

// Typed map (Solidity mapping)
let balances = storage.map::<String, u64>("balance");
balances.save(&"alice".into(), &100)?;
let bal = balances.load(&"alice".into())?;  // Option<u64>
balances.exists(&"alice".into());
balances.remove(&"alice".into());
```

### Host Functions

```rust
use citizen_contract_sdk::prelude::*;

// State
store_state("key", "value");
let val = load_state("key");

// Crypto
let msg_hex = hex_encode(b"hello");
let valid = verify_signature(did, &msg_hex, sig_hex);
let approved = check_governance("proposal-123");

// Blockchain
let block = current_block_height();

// Namespace access
let entry = read_namespace_entry("civic.admin", "entry-123");
write_namespace_entry("civic.election", payload_json);

// Cross-contract calls
let result = call_module("other-contract", r#"{"operation":"foo"}"#);

// Batch verification
let valid_count = verify_signature_batch(batch_json);

// Logging
log_str("something happened");
```

### Response Builder

```rust
Response::success()                          // {"ok":true}
Response::data(json!({"count": 42}))         // {"count":42}
Response::data_str("hello")                  // {"ok":true,"data":"hello"}
Response::raw(r#"{"custom":true}"#)          // {"custom":true}
```

### Error Handling

```rust
// Use ? operator — errors auto-serialize to JSON
pub fn op(ctx: Context) -> Result<Response> {
    let did: String = ctx.param("did")?;     // Param error → JSON
    ctx.require_governance("p1")?;            // Auth error → JSON
    storage.set("k", &42)?;                   // Storage error → JSON
    Ok(Response::success())
}

// Custom errors
return Err(ContractError::Unauthorized("not admin".into()));
return Err(ContractError::msg("custom error"));
```

## Comparison: Raw WASM vs SDK

### Raw WASM (729 lines) — what you used to write:

```rust
fn handle_assign_admin(fields: &[(StackStr, StackStr); 10]) -> u64 {
    let admin_did = field(fields, "admin_did");
    let admin_sig = field(fields, "admin_sig");
    let target_did = field(fields, "target_did");
    let role = { let r = field(fields, "role"); if r.is_empty() { "admin" } else { r } };

    // Manual auth check
    if !is_active_admin(admin_did) { return err("not admin"); }

    // Manual signature message construction
    let mut msg_buf: [u8; 512] = [0; 512];
    let mut msg_len = 0;
    write_bytes(&mut msg_buf, &mut msg_len, b"assign_admin:");
    write_bytes(&mut msg_buf, &mut msg_len, target_did.as_bytes());
    // ... 30 more lines of buffer management ...

    // Manual state operations
    let _ = state_set(&format_key("admin:", target_did), role);
    // ... manual JSON response construction ...
}
```

### SDK (247 lines total) — what you write now:

```rust
pub fn assign_admin(ctx: Context) -> Result<Response> {
    let admin_did: String = ctx.param("admin_did")?;
    let admin_sig: String = ctx.param("admin_sig")?;
    let target_did: String = ctx.param("target_did")?;
    let role: String = ctx.param_or("role", "admin".into());

    let admins = ctx.storage().map::<String, AdminRecord>("admin");

    // Authorization
    admins.load(&admin_did)?.filter(|a| !a.revoked)
        .ok_or_else(|| ContractError::Unauthorized("not an admin".into()))?;

    // Signature
    ctx.require_signature(&admin_did, &format!("assign_admin:{target_did}:{role}"), &admin_sig)?;

    // Typed storage
    admins.save(&target_did, &AdminRecord { did: target_did.clone(), role, .. })?;

    ctx.emit("AdminAssigned", &json!({"admin": target_did}));
    Ok(Response::success())
}
```
