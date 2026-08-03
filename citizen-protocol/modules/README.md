# Sample WASM Smart Contract Modules

This directory contains sample smart contract modules compiled to `wasm32-unknown-unknown`.
Each module is `#![no_std]` and uses the Citizen host function ABI (`alloc`, `handle`, `memory`).

## Modules

| Module | Path | Description |
|--------|------|-------------|
| `access-control-guard` | `access-control/` | Signature-gated access checker demonstrating `verify_signature`, `store_state`, and `current_block_height` host calls. |
| `soulbound-token` | `soulbound-token/` | Non-transferable NFT (SBT) demonstrating state persistence, `mint`/`burn`/`owner_of` operations, and rejection of `transfer`. |

## Building

Each module is self-contained with its own `[workspace]` declaration in `Cargo.toml`
to avoid inheriting from the protocol workspace.

```bash
cd modules/<module-name>
RUSTFLAGS="-C link-arg=--allow-undefined" cargo build --release --target wasm32-unknown-unknown
```

Copy the compiled `.wasm` to the test fixtures directory:

```bash
cp target/wasm32-unknown-unknown/release/<name>.wasm ../crates/execution/tests/fixtures/
```

## Module ABI

Every module must export three items:

| Export | Signature | Purpose |
|--------|-----------|---------|
| `alloc` | `(u32) -> u32` | Bump-allocate `n` bytes in linear memory, return pointer. |
| `handle` | `(u32, u32) -> u64` | Entry point: `(params_ptr, params_len)` → packed `(ptr << 32 \| len)`. |
| `memory` | — | WASM linear memory export. |

Parameters are passed as a JSON string written to the allocated buffer.
The return value is a JSON string read back from the packed pointer/length.
