# Sample WASM Smart Contract Modules

This directory contains sample smart contract modules compiled to `wasm32-unknown-unknown`.
Each module is `#![no_std]` and uses the Citizen host function ABI (`alloc`, `handle`, `memory`).

## Modules

| Module | Path | Description |
|--------|------|-------------|
| `access-control-guard` | `access-control/` | Signature-gated access checker demonstrating `verify_signature`, `store_state`, and `current_block_height` host calls. |
| `ctzn-token` | `ctzn-token/` | CTZN — a soulbound (non-transferable) identity token with multi-issuer authority, tiers, schemas, expiry/revocation, and attribute-based access control. |

## CTZN Token Features

CTZN is a soulbound token: once minted to a recipient, it is permanently bound to that identity. Transfers are always rejected.

| Feature | How it works |
|---------|-------------|
| **Multi-issuer authority** | `configure` operation sets authorized issuer DIDs and a signature threshold. Mints require N-of-M issuer signatures. Initial configuration requires a governance-approved proposal — no one can self-appoint as admin. |
| **Custom metadata schemas** | Each token has a `schema_type` (e.g., `degree`, `reputation`, `identity`) and free-form JSON `metadata`. |
| **Hierarchical tiers** | Tokens are assigned `bronze` (0), `silver` (1), or `gold` (2). Per-tier supply is tracked independently. |
| **Time-locked / revocable** | Optional `expiry_block` makes tokens expire at a future block height. Issuers can `revoke` tokens at any time. |
| **Attribute-based access control** | `check_access` operation verifies token ownership with tier/schema requirements. Supports direct token lookup or enumeration of a DID's holdings. |

### CTZN Operations

| Operation | Parameters | Purpose |
|-----------|-----------|---------|
| `configure` | `admin_did`, `admin_sig`, `proposal_id`, `issuers`, `threshold` | Set authorized issuers and minimum signature count. **Initial call requires a governance-approved `proposal_id`**; subsequent calls require admin signature. |
| `mint` | `issuer_dids`, `signatures`, `token_id`, `recipient_did`, `tier?`, `schema_type?`, `metadata?`, `expiry_block?` | Mint a new CTZN token (backward-compatible with singular `issuer_did`/`signature_hex`) |
| `owner_of` | `token_id` | Get owner and full token status (burned, revoked, expired) |
| `total_supply` | — | Get global and per-tier supply counts |
| `get_metadata` | `token_id` | Get token metadata, tier, schema, and revocation/expiry status |
| `burn` | `issuer_did`, `signature_hex`, `token_id` | Permanently destroy a token |
| `revoke` | `issuer_did`, `signature_hex`, `token_id` | Issuer-revoke a token (keeps record, marks invalid) |
| `transfer` | (any) | Always rejected — CTZN tokens are non-transferable |
| `check_access` | `did`, `token_id?`, `required_tier?`, `required_schema?` | Verify a DID holds a qualifying token |

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
