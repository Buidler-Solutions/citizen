# Cheatsheet

## Boilerplate

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
    pub fn my_op(ctx: Context) -> Result<Response> {
        // ...
        Ok(Response::success())
    }
}
```

## Build

```bash
RUSTFLAGS="-C link-arg=--allow-undefined" cargo build --release --target wasm32-unknown-unknown
```

## Execute

```bash
curl -X POST http://localhost:8091/api/v1/modules/MODULE_ID/execute \
  -H "Content-Type: application/json" \
  -d '{"operation": "my_op", "key": "value"}'
```

## Parameters

```rust
let did: String = ctx.param("did")?;                    // Required
let role: String = ctx.param_or("role", "admin".into()); // Default
let expiry: Option<u64> = ctx.param_opt("expiry")?;      // Optional
let raw: Option<&Value> = ctx.raw_param("data");         // Raw JSON
```

## Storage

```rust
let s = ctx.storage();

// Raw
s.set_str("k", "v")?;           s.get_str("k");        s.remove("k");

// Item<T>
let item = s.item::<u64>("count");
item.save(&42)?;                item.load()?;           item.exists();
item.update(|v| v + 1)?;        item.remove();

// Map<K, V>
let map = s.map::<String, User>("user");
map.save(&k, &v)?;              map.load(&k)?;          map.exists(&k);
map.remove(&k);
```

## Authorization

```rust
ctx.require_governance("proposal-id")?;
ctx.require_signature(did, message, sig_hex)?;
ctx.require_exists("admin:key")?;
```

## Events

```rust
ctx.emit("EventName", &json!({"key": "value"}));
log_str("debug message");
```

## Responses

```rust
Response::success()                      // {"ok":true}
Response::data(json!({...}))             // Custom JSON
Response::data_str("hello")              // {"ok":true,"data":"hello"}
Response::raw(r#"{"x":1}"#)              // Raw JSON string
```

## Errors

```rust
ContractError::msg("reason")                    // Generic
ContractError::Unauthorized("reason".into())     // Auth failure
ContractError::Param("reason".into())            // Bad input
ContractError::Storage("reason".into())          // Storage failure
```

## Host functions

```rust
store_state("k", "v");         load_state("k")
verify_signature(did, &hex_encode(msg.as_bytes()), sig_hex)
verify_signature_batch(batch_json)   // → u32 count
check_governance("proposal-id")      // → bool
current_block_height()               // → u64
read_namespace_entry("ns", "id")     // → Option<String>
write_namespace_entry("ns", json)    // → bool
call_module("module-id", json)       // → Option<String>
log_str("message")
hex_encode(&bytes)                   // → String
```

## Block context

```rust
let block = ctx.block_height();
```

## Cargo.toml template

```toml
[package]
name = "my-contract"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]
name = "my_contract"

[dependencies]
citizen-contract-sdk = { path = "path/to/crates/contract-sdk" }
citizen-contract-derive = { path = "path/to/crates/contract-derive" }
serde = { version = "1", default-features = false, features = ["derive", "alloc"] }
serde_json = { version = "1", default-features = false, features = ["alloc"] }

[profile.release]
opt-level = "s"
lto = true
strip = "none"

[workspace]
```
