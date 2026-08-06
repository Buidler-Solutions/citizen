# Civitas

**Civitas** is the smart contract language and execution environment for the Citizen Protocol. Contracts are written in **Rust**, compiled to **WebAssembly (WASM)**, and executed inside a gas-metered sandbox on every validator node. They have full access to on-chain state, Ed25519 signature verification, governance approval checks, and cross-contract composition.

## Why Civitas?

Most blockchain smart contract platforms force a domain-specific language. Civitas takes a different approach: **you write in Rust** with a SDK that provides Solidity-like ergonomics — typed storage, modifiers, events, and automatic dispatch — but compiles to deterministic WASM running inside Citizen's governance-first execution engine.

| Feature | Solidity (EVM) | Civitas (WASM) |
|---------|---------------|-----------------|
| Language | Solidity | Rust |
| Runtime | EVM | wasmtime (WASM) |
| Storage | Key-value slots | Typed `Item<T>` and `Map<K,V>` |
| Auth | `msg.sender` | `ctx.require_signature()`, `ctx.require_governance()` |
| Events | `emit Event()` | `ctx.emit("Event", &json!({...}))` |
| Cross-contract | `Contract.foo()` | `call_module("contract", params)` |
| State model | Per-address storage | Per-module scoped state |
| Governance | External (no native) | Built-in `host_check_governance_approval` |
| Block context | `block.number`, `block.timestamp` | `ctx.block_height()` |

## How contracts work

```
┌─────────────────────────────────────────────────────────┐
│  Your Contract (Rust source)                            │
│  ├── #[contract] mod contract { pub fn op(ctx) ... }   │
│  └── Compiles to WASM                                   │
└──────────────────────┬──────────────────────────────────┘
                       │ POST /api/v1/modules/:id/execute
                       ▼
┌─────────────────────────────────────────────────────────┐
│  Citizen Node (wasmtime sandbox)                        │
│  ├── Parses JSON params → Context                       │
│  ├── Dispatches to function by name                     │
│  ├── Gas-metered execution                              │
│  ├── Host functions bridge to ledger/storage/crypto     │
│  └── Returns JSON response                              │
└─────────────────────────────────────────────────────────┘
```

## Quick example

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

    pub fn increment(ctx: Context) -> Result<Response> {
        let count = ctx.storage().item::<u64>("count");
        let new_val = count.update(|v| v + 1)?;
        ctx.emit("Incremented", &json!({"value": new_val}));
        Ok(Response::data(json!({"count": new_val})))
    }

    pub fn get_count(ctx: Context) -> Result<Response> {
        let count: u64 = ctx.storage().item::<u64>("count").load()?.unwrap_or(0);
        Ok(Response::data(json!({"count": count})))
    }
}
```

## What you'll learn

This documentation covers everything from setup to advanced patterns:

1. **[Installation](installation.md)** — Toolchain prerequisites and project setup
2. **[Hello World](hello-world.md)** — Build, deploy, and invoke your first contract
3. **[Storage](storage.md)** — Typed state variables and mappings
4. **[Authorization](authorization.md)** — Signature verification and governance gates
5. **[Events](events.md)** — Emit structured events for indexing
6. **[Cross-Contract Calls](cross-contract.md)** — Compose multiple contracts
7. **[Deployment](deployment.md)** — Register and activate contracts on-chain
8. **[Examples & Exercises](exercises/index.md)** — Hands-on practice contracts

## Design principles

- **Governance-first**: Contracts integrate natively with Citizen's governance namespace — no external oracle needed for approval checks.
- **Deterministic**: All host functions return the same result on every validator given the same state. No floating-point, no I/O, no randomness.
- **Sandboxed**: Contracts cannot access the filesystem, network, or host memory outside their allocated region.
- **Gas-metered**: Every instruction consumes gas; execution halts at the limit.
- **Typed**: serde serialization eliminates manual JSON parsing — the SDK handles it.

## Comparison: SDK vs raw WASM

| | Raw WASM | Civitas SDK |
|---|---|---|
| **Lines of code** (admin-registry) | 729 | 247 |
| **JSON parsing** | Hand-rolled parser | `ctx.param::<T>()` |
| **State access** | Manual buffer management | `storage.map::<K,V>()` |
| **Memory management** | Manual `alloc()` | Automatic global allocator |
| **Error handling** | Manual JSON error strings | `Result<T>` with `?` operator |
