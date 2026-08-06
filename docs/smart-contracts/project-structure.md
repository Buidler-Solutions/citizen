# Project Structure

Every Civitas smart contract is a self-contained Rust crate that compiles to `cdylib` (C-compatible dynamic library → WASM). This page explains every part of the setup.

## Directory layout

```
my-contract/
├── Cargo.toml          # Crate manifest
├── src/
│   └── lib.rs          # Contract source (single file or module tree)
└── target/             # Build output (gitignored)
    └── wasm32-unknown-unknown/
        └── release/
            └── my_contract.wasm   # Compiled WASM binary
```

## Cargo.toml explained

```toml
[package]
name = "my-contract"            # Crate name
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]         # Required: produces a .wasm file
name = "my_contract"            # Output filename: my_contract.wasm

[dependencies]
citizen-contract-sdk = { path = "../../citizen-protocol/crates/contract-sdk" }
citizen-contract-derive = { path = "../../citizen-protocol/crates/contract-derive" }
serde = { version = "1", default-features = false, features = ["derive", "alloc"] }
serde_json = { version = "1", default-features = false, features = ["alloc"] }

[profile.release]
opt-level = "s"                 # Optimize for size (WASM binary)
lto = true                      # Link-time optimization
strip = "none"                  # Keep debug symbols for stack traces

[workspace]                     # Prevent inheriting from parent workspace
```

### Key settings

| Setting | Why |
|---------|-----|
| `crate-type = ["cdylib"]` | Tells Cargo to produce a C-compatible library (`.wasm` for the WASM target) |
| `default-features = false` | serde/serde_json default to `std` — contracts are `#![no_std]` |
| `features = ["alloc"]` | Enables heap allocation support in serde (for `String`, `Vec`) |
| `opt-level = "s"` | Smaller binaries = lower deployment gas |
| `[workspace]` | Prevents Cargo from trying to merge this into the protocol workspace |

## Source file anatomy

```rust
// ── 1. Crate attributes ──────────────────────────────────
#![no_std]       // No standard library (no std::fs, std::net, std::thread)
#![no_main]      // No main() function (WASM doesn't use it)

// ── 2. Alloc crate ───────────────────────────────────────
extern crate alloc;   // Enables Vec, String, Box, etc.

// ── 3. Global allocator ──────────────────────────────────
#[global_allocator]
static ALLOC: citizen_contract_sdk::Allocator = citizen_contract_sdk::Allocator;

// ── 4. Imports ───────────────────────────────────────────
use citizen_contract_sdk::prelude::*;
use citizen_contract_derive::contract;
use serde::{Serialize, Deserialize};

// ── 5. State types (outside the module) ──────────────────
#[derive(Serialize, Deserialize)]
struct MyStruct {
    field: String,
    count: u64,
}

// ── 6. Contract module ───────────────────────────────────
#[contract]
mod contract {
    use super::*;   // Bring outer types into scope

    pub fn my_operation(ctx: Context) -> Result<Response> {
        // ... contract logic ...
        Ok(Response::success())
    }
}
```

### Why types go outside `#[contract]`

The `#[contract]` macro generates code around the module. Types like structs and enums that derive `Serialize`/`Deserialize` should be defined in the outer scope so both the module and the generated dispatcher can reference them.

## Multi-file contracts

For larger contracts, split into modules:

```rust
// src/lib.rs
#![no_std]
#![no_main]
extern crate alloc;

#[global_allocator]
static ALLOC: citizen_contract_sdk::Allocator = citizen_contract_sdk::Allocator;

mod types;       // src/types.rs
mod helpers;     // src/helpers.rs

use citizen_contract_sdk::prelude::*;
use citizen_contract_derive::contract;

#[contract]
mod contract {
    use super::*;
    use super::types::*;
    use super::helpers::*;

    pub fn operation(ctx: Context) -> Result<Response> {
        let item: MyType = load_thing(&ctx)?;
        do_work(&ctx, &item)?;
        Ok(Response::success())
    }
}
```

```
src/
├── lib.rs        // Entry point + #[contract] module
├── types.rs      // Struct/enum definitions
└── helpers.rs    // Internal utility functions
```

## Build command

Always use this exact command:

```bash
RUSTFLAGS="-C link-arg=--allow-undefined" cargo build --release --target wasm32-unknown-unknown
```

| Flag | Purpose |
|------|---------|
| `--release` | Optimized build (required — debug WASM is 5-10x larger) |
| `--target wasm32-unknown-unknown` | Compile to WASM instead of native |
| `RUSTFLAGS="-C link-arg=--allow-undefined"` | Allow unresolved host function imports |

!!! tip "Create a build alias"
    Add to your shell profile:
    ```bash
    alias build-contract='RUSTFLAGS="-C link-arg=--allow-undefined" cargo build --release --target wasm32-unknown-unknown'
    ```

## Binary size guide

| Contract | WASM Size |
|----------|-----------|
| Minimal (ping/pong) | ~100 KB |
| Counter (4 operations) | ~105 KB |
| Admin registry (7 operations) | ~160 KB |
| Voting trust (8 operations) | ~165 KB |

WASM binaries include serde and serde_json, which account for ~80KB baseline. Use `opt-level = "s"` and `lto = true` to keep size down.

## Next steps

- [Storage](storage.md) — Typed state variables and mappings
- [Context & Parameters](context.md) — Reading operation parameters
