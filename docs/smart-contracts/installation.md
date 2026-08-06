# Installation

## Prerequisites

### 1. Rust toolchain

Install Rust via [rustup](https://rustup.rs):

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Add the WASM compilation target:

```bash
rustup target add wasm32-unknown-unknown
```

Verify:

```bash
rustc --version    # 1.75+ recommended
cargo --version
rustup target list --installed | grep wasm32
# wasm32-unknown-unknown
```

### 2. Citizen Protocol node

You need a running Citizen node to deploy and test contracts. See the [Node Operators guide](../node-operators/running-a-node.md) for full instructions, or use the local stack:

```bash
git clone https://github.com/greenarmor/citizen.git
cd citizen
bash scripts/start-local-stack.sh
```

The node API will be available at `http://127.0.0.1:8091`.

### 3. Python (for deployment scripts)

```bash
python3 --version    # 3.8+
pip3 install pynacl   # For signing deployment transactions
```

## SDK crates

The Citizen Contract SDK consists of two crates inside the protocol workspace:

| Crate | Path | Purpose |
|-------|------|---------|
| `citizen-contract-sdk` | `crates/contract-sdk/` | Runtime library: storage, context, host FFI |
| `citizen-contract-derive` | `crates/contract-derive/` | Proc macros: `#[contract]` auto-dispatch |

You don't install these from crates.io — you reference them by path in your contract's `Cargo.toml`.

## Verify your setup

Create a minimal contract and build it:

```bash
cargo new --lib hello-citizen
cd hello-citizen
```

Edit `Cargo.toml` (see [Project Structure](project-structure.md) for details):

```toml
[package]
name = "hello-citizen"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]
name = "hello_citizen"

[dependencies]
citizen-contract-sdk = { path = "../citizen/citizen-protocol/crates/contract-sdk" }
citizen-contract-derive = { path = "../citizen/citizen-protocol/crates/contract-derive" }
serde = { version = "1", default-features = false, features = ["derive", "alloc"] }
serde_json = { version = "1", default-features = false, features = ["alloc"] }

[profile.release]
opt-level = "s"
lto = true
strip = "none"

[workspace]
```

Write `src/lib.rs`:

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

    pub fn ping(ctx: Context) -> Result<Response> {
        Ok(Response::data(json!({"pong": true})))
    }
}
```

Build:

```bash
RUSTFLAGS="-C link-arg=--allow-undefined" cargo build --release --target wasm32-unknown-unknown
```

If you see a `.wasm` file in `target/wasm32-unknown-unknown/release/`, your setup is correct.

??? tip "Troubleshooting: `link-arg=--allow-undefined`"
    The `RUSTFLAGS` setting tells the linker to allow unresolved extern declarations (the host functions). Without it, linking fails because `host_store_state`, `host_verify_signature`, etc. are not defined at compile time — they're provided by the node at runtime.

??? tip "Troubleshooting: `error: no global memory allocator found`"
    Make sure you have `#[global_allocator] static ALLOC: citizen_contract_sdk::Allocator = citizen_contract_sdk::Allocator;` at the top of your `lib.rs`. This wires Rust's `alloc` crate (Vec, String) to the SDK's bump allocator.

## Next steps

- [Hello World](hello-world.md) — Build and deploy your first useful contract
- [Project Structure](project-structure.md) — Understand the Cargo.toml and file layout
