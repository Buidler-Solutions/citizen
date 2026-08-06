# Host Functions

Citizen contracts interact with the blockchain through **host functions** — WASM imports provided by the node's execution engine. The SDK wraps all 10 host functions with ergonomic Rust bindings.

## Overview

| Function | SDK wrapper | Purpose |
|----------|-------------|---------|
| `host_store_state` | `store_state()` | Write to contract state |
| `host_load_state` | `load_state()` | Read from contract state |
| `host_verify_signature` | `verify_signature()` | Verify Ed25519 signature |
| `host_verify_signature_batch` | `verify_signature_batch()` | Batch signature verification |
| `host_check_governance_approval` | `check_governance()` | Check governance proposal status |
| `host_current_block_height` | `current_block_height()` | Get current block number |
| `host_read_namespace_entry` | `read_namespace_entry()` | Read any namespace entry |
| `host_write_namespace_entry` | `write_namespace_entry()` | Write to any namespace |
| `host_call_module` | `call_module()` | Cross-contract call |
| `host_log` | `log_str()` | Emit log message |

## State functions

### `store_state`

```rust
store_state("my_key", "my_value");  // Returns bool
```

Stores a key-value pair in the contract's scoped state. Returns `true` on success.

Values are limited to 1024 bytes. Keys are arbitrary strings.

### `load_state`

```rust
let val = load_state("my_key");  // Returns Option<String>
```

Loads a value by key. Returns `None` if not found or if the value is empty.

## Cryptography functions

### `verify_signature`

```rust
let msg_hex = hex_encode(b"hello world");
let valid = verify_signature(
    "did:key:ed25519:...",  // Signer DID
    &msg_hex,                // Hex-encoded message
    "abcdef0123456789..."    // Hex-encoded signature
);  // Returns bool
```

!!! important "Message must be hex-encoded"
    The host function expects the message as hex-encoded bytes, not as a raw string. Use `hex_encode()` to convert:
    ```rust
    let msg_hex = hex_encode(message.as_bytes());
    ```

### `verify_signature_batch`

```rust
let batch_json = r#"[
    {"did":"did:key:...","message_hex":"68656c6c6f","signature_hex":"..."},
    {"did":"did:key:...","message_hex":"776f726c64","signature_hex":"..."}
]"#;
let valid_count = verify_signature_batch(batch_json);  // Returns u32
```

Verifies multiple signatures in a single host call (more efficient than calling `verify_signature` N times). Maximum 256 items per batch.

### `check_governance`

```rust
let approved = check_governance("proposal-123");  // Returns bool
```

Returns `true` if the governance namespace contains an `APPROVED` entry for the given proposal ID. **Fails closed** — returns `false` if no entry is found.

## Blockchain functions

### `current_block_height`

```rust
let block = current_block_height();  // Returns u64
```

Returns the current block height. Same as `ctx.block_height()`.

## Namespace functions

### `read_namespace_entry`

```rust
let entry = read_namespace_entry("civic.admin", "entry-uuid-123");  // Option<String>
```

Reads an entry from any namespace on the ledger. Returns the entry's payload as a JSON string, or `None` if not found.

!!! warning "Authorization"
    Contracts can read any namespace but writes require proper authorization (signature checks, namespace rules).

### `write_namespace_entry`

```rust
let success = write_namespace_entry("civic.election", r#"{"action":"OPEN_ELECTION"}"#);  // bool
```

Writes an entry to a namespace. Returns `true` on success. The namespace must allow the contract module as a writer (configured in the validator TOML).

## Cross-contract function

### `call_module`

```rust
let result = call_module(
    "token-contract",
    r#"{"operation":"transfer","from":"alice","to":"bob","amount":10}"#
);  // Option<String>
```

Calls another activated module and returns its JSON response. See [Cross-Contract Calls](cross-contract.md) for details.

## Utility functions

### `hex_encode`

```rust
let hex = hex_encode(b"hello");  // "68656c6c6f"
```

Encodes bytes to a lowercase hex string. Required for `verify_signature` and `verify_signature_batch`.

### `log_str`

```rust
log_str("debug: entered transfer function");
```

Emits a message to the node logs. Visible in execution receipts.

## Security model

### Import whitelist

The execution engine validates all WASM imports at registration time. Only the 10 listed functions from the `"env"` module are allowed:

```rust
// In engine.rs — validate_module_imports()
for import in module.imports() {
    if import.module() != "env" {
        return Err(SecurityViolation("unauthorized namespace"));
    }
    if !ALLOWED_HOST_FUNCTIONS.contains(import.name()) {
        return Err(SecurityViolation("unknown host function"));
    }
}
```

Any attempt to import `env.read_file`, `env.http_get`, or other functions will be rejected before the module ever executes.

### Gas metering

All host function calls consume gas. The execution engine tracks fuel (wasmtime) and charges for:

- Each WASM instruction executed
- Each host function call
- Memory allocations
- Cross-contract call depth

If gas is exhausted, execution traps immediately with `GasLimitExceeded`.

## Next steps

- [Cross-Contract Calls](cross-contract.md) — Composing contracts
- [Raw WASM API](raw-wasm.md) — Low-level bindings without the SDK
