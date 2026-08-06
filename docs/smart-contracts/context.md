# Context & Parameters

The `Context` object is passed to every contract operation. It provides typed parameter extraction, block information, storage access, and authorization helpers — the Solidity `msg.*` and `block.*` equivalent.

## Creating a context

You never create a `Context` manually. The `#[contract]` macro generates a dispatcher that parses the incoming JSON and passes the `Context` to your function:

```rust
pub fn my_op(ctx: Context) -> Result<Response> {
    // ctx contains the parsed JSON params
}
```

## Parameter extraction

### Required parameters

Use `ctx.param::<T>()` — returns `ContractError` if missing or wrong type:

```rust
pub fn transfer(ctx: Context) -> Result<Response> {
    let from: String = ctx.param("from")?;
    let to: String = ctx.param("to")?;
    let amount: u64 = ctx.param("amount")?;

    // If "from" is missing → ContractError::Param("missing parameter: from")
    // If "amount" is a string → ContractError::Param("invalid amount: ...")

    Ok(Response::success())
}
```

### Parameters with defaults

Use `ctx.param_or()` — returns the default if missing:

```rust
pub fn configure(ctx: Context) -> Result<Response> {
    let role: String = ctx.param_or("role", "admin".into());
    let max_retries: u64 = ctx.param_or("max_retries", 3);
    let enabled: bool = ctx.param_or("enabled", true);

    Ok(Response::success())
}
```

### Optional parameters

Use `ctx.param_opt()` — returns `None` if not provided:

```rust
pub fn create_token(ctx: Context) -> Result<Response> {
    let name: String = ctx.param("name")?;              // Required
    let expiry: Option<u64> = ctx.param_opt("expiry")?; // Optional

    match expiry {
        Some(blocks) => ctx.emit("Created", &json!({"expiry": blocks})),
        None => ctx.emit("Created", &json!({"expiry": null})),
    }

    Ok(Response::success())
}
```

### Raw JSON access

Use `ctx.raw_param()` for complex or nested values:

```rust
pub fn batch_create(ctx: Context) -> Result<Response> {
    if let Some(items) = ctx.raw_param("items") {
        // items is a &serde_json::Value
        if let Some(arr) = items.as_array() {
            for item in arr {
                let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("");
                // ...
            }
        }
    }
    Ok(Response::success())
}
```

### Supported types

Any type implementing `serde::DeserializeOwned` works:

| Rust type | JSON type | Example JSON |
|-----------|-----------|-------------|
| `String` | string | `"hello"` |
| `u64`, `u32`, `i64` | number | `42` |
| `bool` | boolean | `true` |
| `Vec<String>` | array | `["a","b"]` |
| Custom struct | object | `{"name":"x"}` |
| `Option<T>` | any or null | `42` or `null` |

## Block context

### Current block height

```rust
pub fn check_deadline(ctx: Context) -> Result<Response> {
    let current_block = ctx.block_height();

    let proposal_end: u64 = ctx.storage()
        .item::<u64>("proposal_end_block")
        .load()?.unwrap_or(0);

    let expired = current_block >= proposal_end;

    Ok(Response::data(json!({
        "current_block": current_block,
        "end_block": proposal_end,
        "expired": expired
    })))
}
```

!!! note "No `block.timestamp`"
    Citizen uses block height, not wall-clock time. This ensures determinism — all validators agree on the current block number, but may disagree on the current time.

## Storage access

See [Storage](storage.md) for full details:

```rust
pub fn my_op(ctx: Context) -> Result<Response> {
    let storage = ctx.storage();

    // Raw
    storage.set_str("key", "value")?;

    // Typed
    let count = storage.item::<u64>("count");
    let users = storage.map::<String, User>("user");

    Ok(Response::success())
}
```

## Events

See [Events](events.md) for full details:

```rust
pub fn transfer(ctx: Context) -> Result<Response> {
    let from: String = ctx.param("from")?;
    let to: String = ctx.param("to")?;
    let amount: u64 = ctx.param("amount")?;

    // ...

    ctx.emit("Transfer", &json!({
        "from": from,
        "to": to,
        "amount": amount
    }));

    Ok(Response::success())
}
```

## Complete example

```rust
pub fn create_proposal(ctx: Context) -> Result<Response> {
    // Required params
    let id: String = ctx.param("proposal_id")?;
    let title: String = ctx.param("title")?;
    let proposer: String = ctx.param("proposer")?;

    // Optional params with defaults
    let duration: u64 = ctx.param_or("duration", 1000);
    let quorum: u32 = ctx.param_or("quorum_bps", 6667);

    // Block context
    let block = ctx.block_height();

    // Storage
    let proposals = ctx.storage().map::<String, Proposal>("proposal");

    // Guard: no duplicates
    if proposals.exists(&id) {
        return Err(ContractError::msg("proposal already exists"));
    }

    // Create
    let proposal = Proposal {
        id: id.clone(),
        title,
        proposer,
        start_block: block,
        end_block: block + duration,
        quorum_bps: quorum,
        ..Default::default()
    };

    proposals.save(&id, &proposal)?;

    // Event
    ctx.emit("ProposalCreated", &json!({
        "id": id,
        "block": block
    }));

    Ok(Response::success())
}
```

## Next steps

- [Authorization](authorization.md) — Add signature and governance requirements
- [Responses](responses.md) — Build return values
