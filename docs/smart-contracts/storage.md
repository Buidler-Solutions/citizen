# Storage

Contracts persist state across invocations using the `host_store_state` and `host_load_state` host functions. The SDK provides three storage patterns that wrap these with type safety and automatic serialization.

## Storage accessor

All storage operations go through `ctx.storage()`:

```rust
pub fn my_op(ctx: Context) -> Result<Response> {
    let storage = ctx.storage();
    // ...
}
```

## Pattern 1: Raw key-value strings

For simple flags, counters stored as strings, or when you need full control:

```rust
let storage = ctx.storage();

// Write
storage.set_str("my_key", "my_value")?;

// Read (returns Option<String>)
let val = storage.get_str("my_key");  // Some("my_value")

// Check existence
if storage.exists("my_key") { ... }

// Remove
storage.remove("my_key");
```

!!! note "Keys are per-module scoped"
    Two contracts can both use the key `"count"` without colliding. State is namespaced by module ID automatically.

## Pattern 2: Typed items (`Item<T>`)

For single-value state variables (Solidity state variable equivalent):

```rust
#[derive(Serialize, Deserialize)]
struct Config {
    admin: String,
    max_size: u64,
    enabled: bool,
}

pub fn set_config(ctx: Context) -> Result<Response> {
    let config = ctx.storage().item::<Config>("config");
    config.save(&Config {
        admin: "did:key:...".into(),
        max_size: 1024,
        enabled: true,
    })?;
    Ok(Response::success())
}

pub fn get_config(ctx: Context) -> Result<Response> {
    let config = ctx.storage().item::<Config>("config");
    let cfg = config.load()?;  // Option<Config>
    Ok(Response::data(json!({"config": cfg})))
}
```

### `Item<T>` methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `save` | `(&self, &T) -> Result<()>` | Write value (JSON-serialized) |
| `load` | `(&self) -> Result<Option<T>>` | Read value (None if unset) |
| `exists` | `(&self) -> bool` | Check if key is set |
| `remove` | `(&self)` | Clear the slot |
| `update` | `(&self, F: FnOnce(T) -> T) -> Result<T>` | Read-modify-write (requires `T: Default`) |

### Update pattern

```rust
let counter = ctx.storage().item::<u64>("count");
let new_val = counter.update(|v| v + 1)?;
```

This is equivalent to:

```rust
let counter = ctx.storage().item::<u64>("count");
let current = counter.load()?.unwrap_or_default();  // u64::default() = 0
let new_val = current + 1;
counter.save(&new_val)?;
```

!!! warning "Default trait required for `update`"
    `update()` requires `T: Default` because it uses `unwrap_or_default()` when the slot is empty. For types without a sensible default, use `load()` + `save()` manually.

## Pattern 3: Typed maps (`Map<K, V>`)

For keyed lookups (Solidity `mapping(K => V)` equivalent):

```rust
#[derive(Serialize, Deserialize)]
struct Balance {
    amount: u64,
    locked: u64,
}

pub fn get_balance(ctx: Context) -> Result<Response> {
    let did: String = ctx.param("did")?;
    let balances = ctx.storage().map::<String, Balance>("balance");

    let bal = balances.load(&did)?;  // Option<Balance>

    Ok(Response::data(json!({
        "did": did,
        "balance": bal
    })))
}

pub fn set_balance(ctx: Context) -> Result<Response> {
    let did: String = ctx.param("did")?;
    let amount: u64 = ctx.param("amount")?;

    let balances = ctx.storage().map::<String, Balance>("balance");
    balances.save(&did, &Balance { amount, locked: 0 })?;

    Ok(Response::success())
}
```

### How keys work

A `Map<K, V>` with prefix `"balance"` stores entries at keys formatted as `"balance:<K>"`:

```
Storage key              Value (JSON)
─────────────────────    ──────────────────────
balance:alice            {"amount":100,"locked":0}
balance:bob              {"amount":50,"locked":10}
balance:charlie          {"amount":0,"locked":0}
```

### `Map<K, V>` methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `save` | `(&self, &K, &V) -> Result<()>` | Write value at key |
| `load` | `(&self, &K) -> Result<Option<V>>` | Read value at key |
| `exists` | `(&self, &K) -> bool` | Check if key exists |
| `remove` | `(&self, &K)` | Clear entry at key |

### Key type requirements

The key type `K` must implement `ToString`. Built-in types that work:

- `String`
- `&str` (via `String::from()`)
- `u64`, `u32`, `i64`, etc.
- Any custom type that implements `Display`

```rust
// Numeric keys
let tokens = ctx.storage().map::<u64, TokenData>("token");
tokens.save(&1, &TokenData { ... })?;
let token = tokens.load(&1)?;
```

## Enumerating entries

The SDK doesn't provide automatic enumeration (like Solidity's `mapping` iteration). The standard pattern is to maintain a comma-separated index:

```rust
pub fn add_member(ctx: Context) -> Result<Response> {
    let did: String = ctx.param("did")?;
    let storage = ctx.storage();

    // Save the member record
    let members = storage.map::<String, Member>("member");
    members.save(&did, &Member { did: did.clone(), ... })?;

    // Update the index
    let mut list = storage.get_str("member_list").unwrap_or_default();
    if !list.is_empty() { list.push(','); }
    list.push_str(&did);
    storage.set_str("member_list", &list)?;

    Ok(Response::success())
}

pub fn list_members(ctx: Context) -> Result<Response> {
    let storage = ctx.storage();
    let list = storage.get_str("member_list").unwrap_or_default();
    let members = storage.map::<String, Member>("member");

    let mut result = Vec::new();
    for did in list.split(',') {
        if did.is_empty() { continue; }
        if let Some(m) = members.load(&did.to_string())? {
            result.push(json!({"did": m.did}));
        }
    }

    Ok(Response::data(json!({"members": result, "count": result.len()})))
}
```

## Serialization format

All typed storage uses serde JSON serialization under the hood:

```rust
// This struct:
struct AdminRecord {
    did: String,
    role: String,
    revoked: bool,
}

// Is stored as this JSON string:
// {"did":"did:key:...","role":"admin","revoked":false}
```

This means:

- Types must derive `Serialize` and `Deserialize`
- Changes to struct fields after deployment will break deserialization
- Values are limited to 1024 bytes per key (host buffer size)

!!! warning "Schema evolution"
    Adding new fields to a stored struct will cause deserialization failures for old entries. Either:
    - Use `#[serde(default)]` on new fields
    - Store a version number and handle migrations
    - Never change struct shapes (use a new module version instead)

## Direct host function access

For advanced use cases, call the raw host functions:

```rust
use citizen_contract_sdk::prelude::*;

// Direct store
store_state("my_key", "raw_value");

// Direct load
let val = load_state("my_key");

// Check
if load_state("initialized").is_some() { ... }
```

## Next steps

- [Context & Parameters](context.md) — How to read operation inputs
- [Authorization](authorization.md) — Restricting who can call your operations
