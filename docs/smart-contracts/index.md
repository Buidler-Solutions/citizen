# Smart Contracts (WASM Modules)

Citizen smart contracts are **deterministic WASM modules** that execute in the wasmtime runtime. Unlike EVM or Soroban contracts, Citizen modules are governance-gated, namespace-scoped, and directly integrated with the ledger's policy engine.

---



## Lifecycle

```
1. REGISTER_MODULE   — Submit WASM bytecode + metadata
         │
2. ACTIVATE_MODULE   — Governance approval gates activation
         │
3. EXECUTE_MODULE    — Run the module with parameters
         │
4. STATE_WRITE       — Module persists state via host_store_state
```

## Host Functions

All 10 host functions are available to modules. They bridge the WASM sandbox to the Citizen ledger:

| Function | Signature | Returns |
|----------|-----------|---------|
| `host_log` | `(ptr, len)` | — |
| `host_read_namespace_entry` | `(ns, eid, out_buf, buf_len)` | `(written << 32) \| status` |
| `host_verify_signature` | `(did, msg, sig)` | `1` valid / `0` invalid |
| `host_verify_signature_batch` | `(json)` | count of valid signatures |
| `host_check_governance_approval` | `(proposal_id)` | `1` approved / `0` not |
| `host_current_block_height` | `()` | `u64` block height |
| `host_store_state` | `(key, value)` | `0` ok / `1` error |
| `host_load_state` | `(key, out_buf, buf_len)` | `(written << 32) \| status` |
| `host_write_namespace_entry` | `(ns, payload, out_buf, buf_len)` | `(written << 32) \| status` |
| `host_call_module` | `(target, params, out_buf, buf_len)` | `(written << 32) \| status` |

!!! tip "Use the SDK"
    You don't need to call these raw. Use `citizen-module-sdk` which wraps everything in clean Rust functions.

## Module ABI

Every module must export:

```rust
#[no_mangle]
pub extern "C" fn alloc(size: u32) -> u32;
// ── Returns a pointer in linear memory

#[no_mangle]
pub extern "C" fn handle(params_ptr: u32, params_len: u32) -> u64;
// ── Packed result: (result_ptr << 32) | result_len
```

## Writing Your First Module

### 1. Create the project

```bash
cargo new --lib my-guard
cd my-guard
```

### 2. Configure `Cargo.toml`

```toml
[package]
name = "my-guard"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
citizen-module-sdk = { path = "../citizen-protocol/crates/module-sdk" }
```

### 3. Write the module

```rust
// src/lib.rs
#![no_std]

use citizen_module_sdk::*;

// Bump allocator — required
static mut BUMP: u32 = 0;

#[no_mangle]
pub extern "C" fn alloc(size: u32) -> u32 {
    unsafe {
        let ptr = 1024 + BUMP;
        if ptr + size > 65536 { return 0; }
        BUMP += (size + 3) & !3;
        ptr
    }
}

#[no_mangle]
pub extern "C" fn handle(params_ptr: u32, params_len: u32) -> u64 {
    let params = read_params_str(params_ptr, params_len);

    let op = field(params, "operation").unwrap_or("");
    let did = field(params, "signer_did").unwrap_or("");
    let msg = field(params, "message_hex").unwrap_or("");
    let sig = field(params, "signature_hex").unwrap_or("");

    match op {
        "check_access" => {
            let valid = verify_signature(did, msg, sig);
            let result = if valid {
                r#"{"allowed":true,"reason":"ok"}"#
            } else {
                r#"{"allowed":false,"reason":"invalid signature"}"#
            };
            write_result(result)
        }
        _ => write_result(r#"{"error":"unknown operation"}"#),
    }
}

fn write_result(s: &str) -> u64 {
    let len = s.len() as u32;
    let ptr = alloc(len + 1);
    if ptr == 0 { return 0; }
    unsafe {
        core::slice::from_raw_parts_mut(ptr as *mut u8, len as usize)
    }.copy_from_slice(s.as_bytes());
    ((ptr as u64) << 32) | (len as u64)
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! { loop {} }
```

### 4. Build

```bash
RUSTFLAGS="-C link-arg=--allow-undefined" \
  cargo build --release --target wasm32-unknown-unknown
```

The compiled `.wasm` file is at `target/wasm32-unknown-unknown/release/my_guard.wasm`.

### 5. Deploy

Base64-encode the WASM file and submit a `REGISTER_MODULE` entry:

```bash
WASM_B64=$(base64 -i target/wasm32-unknown-unknown/release/my_guard.wasm | tr -d '\n')

citizen-wallet-cli submit \
  --namespace execution.module \
  --payload '{
    "action": "REGISTER_MODULE",
    "module_id": "my-guard.v1",
    "module_class": "access-control",
    "wasm_hash": "'$(sha256sum my_guard.wasm | cut -d' ' -f1)'",
    "audit_hash": "'$(sha256sum my_guard.wasm | cut -d' ' -f1)'",
    "wasm_bytes": "'$WASM_B64'"
  }'
```

### 6. Activate

```bash
citizen-wallet-cli submit \
  --namespace execution.module \
  --payload '{
    "action": "ACTIVATE_MODULE",
    "module_id": "my-guard.v1",
    "governance_approvals": 3
  }'
```

### 7. Execute

```bash
citizen-wallet-cli submit \
  --namespace execution.module \
  --payload '{
    "action": "EXECUTE_MODULE",
    "module_id": "my-guard.v1",
    "deterministic_gas_limit": 500000,
    "deterministic_receipt_hash": "...",
    "execution_params": {
      "operation": "check_access",
      "signer_did": "did:key:ed25519:z6Mk...",
      "message_hex": "deadbeef",
      "signature_hex": "abcdef..."
    }
  }'
```

---

## Persistent Storage

Modules can store data that persists across invocations. Storage is scoped to the module ID — two different modules cannot read each other's state.

=== "Using the SDK"
    ```rust
    use citizen_module_sdk::*;

    // Store
    store_state("counter", "42");

    // Load
    let val = load_state("counter");
    // val = Some("42")
    ```

=== "Raw host call"
    ```rust
    extern "C" {
        fn host_store_state(
            key_ptr: *const u8, key_len: u32,
            val_ptr: *const u8, val_len: u32,
        ) -> u32;
        fn host_load_state(
            key_ptr: *const u8, key_len: u32,
            out_ptr: *mut u8, out_len: u32,
        ) -> u64;
    }
    ```



Every module execution consumes gas (fuel). The submitter specifies a `deterministic_gas_limit` in the `EXECUTE_MODULE` entry:

```json
{
  "action": "EXECUTE_MODULE",
  "module_id": "my-guard.v1",
  "deterministic_gas_limit": 500000,
  "execution_params": { "operation": "check_access", ... }
}
```

- If the module runs out of fuel before completing, execution fails with `GasLimitExceeded`
- Gas consumption is **deterministic** — same inputs always consume the same gas
- Simple access-control modules typically consume ~200 gas
- Modules with loops or storage access consume more

## Multi-Signature (Multisig)

Modules can require N-of-M wallet approvals using the batch signature verification function:

```rust
use citizen_module_sdk::*;

let batch = r#"[
    {"signer_did":"did:key:ed25519:alice","message_hex":"aa","signature_hex":"bb"},
    {"signer_did":"did:key:ed25519:bob","message_hex":"aa","signature_hex":"cc"},
    {"signer_did":"did:key:ed25519:carol","message_hex":"aa","signature_hex":"dd"}
]"#;

let valid_count = verify_signature_batch(batch);
let threshold: u32 = 2;

if valid_count >= threshold {
    // Operation approved
    store_state("approved", "true");
}
```

The batch is a JSON array of `{signer_did, message_hex, signature_hex}` objects. The host verifies all signatures in a single call and returns the count of valid ones.

---

## Exercises

### Exercise 1: Access Control Guard

Write a module that accepts a signer DID, message, and signature. Verify the signature and return `{"allowed": true}` or `{"allowed": false}`.

**Parameters:**
```json
{
  "operation": "check_access",
  "signer_did": "did:key:ed25519:...",
  "message_hex": "...",
  "signature_hex": "..."
}
```

**Expected output:**
```json
{"allowed": true, "reason": "signature verified"}
```

??? hint "Solution"
    ```rust
    let valid = verify_signature(did, msg, sig);
    if valid {
        write_result(r#"{"allowed":true,"reason":"signature verified"}"#)
    } else {
        write_result(r#"{"allowed":false,"reason":"invalid signature"}"#)
    }
    ```

### Exercise 2: Stateful Counter

Write a module that maintains a counter in persistent state. Support `increment` and `get_count` operations.

**Parameters for increment:**
```json
{"operation": "increment"}
```

**Parameters for get_count:**
```json
{"operation": "get_count"}
```

**Expected output for get_count:**
```json
{"count": 5}
```

??? hint "Solution"
    ```rust
    match op {
        "increment" => {
            let current = load_state("counter")
                .and_then(|v| v.parse::<u32>().ok())
                .unwrap_or(0);
            let next = current + 1;
            store_state("counter", &next.to_string());
            write_result(&format!(r#"{{"count":{}}}"#, next))
        }
        "get_count" => {
            let current = load_state("counter")
                .and_then(|v| v.parse::<u32>().ok())
                .unwrap_or(0);
            write_result(&format!(r#"{{"count":{}}}"#, current))
        }
        _ => write_result(r#"{"error":"unknown operation"}"#),
    }
    ```

### Exercise 3: Multisig Escrow

Write a module that requires 2-of-3 wallet approvals before releasing.

**Parameters for propose:**
```json
{
  "operation": "propose",
  "proposal_id": "escrow-001",
  "threshold": 2
}
```

**Parameters for approve:**
```json
{
  "operation": "approve",
  "proposal_id": "escrow-001",
  "signatures": [
    {"signer_did": "...", "message_hex": "escrow-001", "signature_hex": "..."},
    {"signer_did": "...", "message_hex": "escrow-001", "signature_hex": "..."}
  ]
}
```

??? hint "Solution outline"
    1. On `propose`: store `threshold` and initialize `approvals` count in state
    2. On `approve`: call `verify_signature_batch(signatures_json)` to count valid sigs
    3. If count >= threshold: store `status: "released"`
    4. Return `{"released": true/false, "approvals": count, "threshold": threshold}`

### Exercise 4: Block-Gated Operation

Write a module that only executes after a specific block height.

**Parameters:**
```json
{
  "operation": "execute_after_block",
  "min_block": 100,
  "payload": "..."
}
```

??? hint "Solution"
    ```rust
    let min_block: u64 = field(params, "min_block")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let current = current_block_height();
    if current < min_block {
        write_result(r#"{"executed":false,"reason":"block too low"}"#)
    } else {
        // Execute the payload logic
        write_result(r#"{"executed":true}"#)
    }
    ```

### Exercise 5: Governance-Gated Action

Write a module that checks governance approval before executing.

**Parameters:**
```json
{
  "operation": "governed_action",
  "proposal_id": "gov-042"
}
```

??? hint "Solution"
    ```rust
    let approved = check_governance_approval("gov-042");
    if !approved {
        write_result(r#"{"executed":false,"reason":"proposal not approved"}"#)
    } else {
        write_result(r#"{"executed":true}"#)
    }
    ```

---

## Sample Modules

The Citizen repository ships with two reference WASM modules demonstrating real-world patterns:

| Module | Path | Description |
|--------|------|-------------|
| **Access Control Guard** | `modules/access-control/` | Signature-gated access checker demonstrating `verify_signature`, `store_state`, and `current_block_height` |
| **CTZN Token** | `modules/ctzn-token/` | Soulbound identity token with multi-issuer authority, tiers, schemas, expiry/revocation, and attribute-based access control |

See the [CTZN Token](ctzn-token.md) page for full documentation of the token module's operations, governance gate, and state model.

### Building Sample Modules

```bash
cd citizen-protocol/modules/<module-name>
RUSTFLAGS="-C link-arg=--allow-undefined" cargo build --release --target wasm32-unknown-unknown
```

---

## Migration Guide

### From Solidity to Citizen WASM

| Solidity Concept | Citizen Equivalent |
|-----------------|-------------------|
| `msg.sender` | `field(params, "signer_did")` + `verify_signature` |
| `mapping(address => uint)` | `store_state(key, value)` + `load_state(key)` |
| `require(msg.sender == owner)` | `verify_signature` + comparison |
| `emit Event(...)` | `log("message")` |
| `block.number` | `current_block_height()` |
| `onlyOwner` modifier | `check_governance_approval(proposal_id)` |


### From Soroban to Citizen WASM

| Soroban Concept | Citizen Equivalent |
|----------------|-------------------|
| `env.storage().set(...)` | `store_state(key, value)` |
| `env.storage().get(...)` | `load_state(key)` |
| `env.ledger().sequence()` | `current_block_height()` |
| `require_auth()` | `verify_signature` |
| `Address` type | `signer_did` string |
| `BytesN<32>` | WASM memory pointer + length |

