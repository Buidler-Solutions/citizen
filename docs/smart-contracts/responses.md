# Responses

Every contract operation returns a `Result<Response>`. The `Response` type wraps a JSON string that the runtime reads back from WASM memory.

## Response builders

### Success

```rust
Ok(Response::success())
// Output: {"ok":true}
```

### JSON data

```rust
Ok(Response::data(json!({
    "is_admin": true,
    "role": "commissioner",
    "count": 42
})))
// Output: {"is_admin":true,"role":"commissioner","count":42}
```

### String data

```rust
Ok(Response::data_str("hello"))
// Output: {"ok":true,"data":"hello"}
```

### Raw JSON

```rust
Ok(Response::raw(r#"{"custom":"format"}"#))
// Output: {"custom":"format"}
```

## Pattern: Query responses

For read-only operations, return the queried data directly:

```rust
pub fn get_balance(ctx: Context) -> Result<Response> {
    let did: String = ctx.param("did")?;
    let balances = ctx.storage().map::<String, u64>("balance");
    let amount = balances.load(&did)?.unwrap_or(0);

    Ok(Response::data(json!({
        "did": did,
        "balance": amount
    })))
}
```

## Pattern: Mutation responses

For state-changing operations, return success with relevant data:

```rust
pub fn transfer(ctx: Context) -> Result<Response> {
    let from: String = ctx.param("from")?;
    let to: String = ctx.param("to")?;
    let amount: u64 = ctx.param("amount")?;

    // ... transfer logic ...

    Ok(Response::data(json!({
        "from": from,
        "to": to,
        "amount": amount,
        "block": ctx.block_height()
    })))
}
```

## Pattern: Computed results

For operations that compute and return values:

```rust
pub fn tally(ctx: Context) -> Result<Response> {
    let proposal_id: String = ctx.param("proposal_id")?;

    // ... tally logic ...

    Ok(Response::data(json!({
        "passed": true,
        "for_votes": 150,
        "against_votes": 30,
        "participation_bps": 6500,
        "met_quorum": true
    })))
}
```

## Pattern: List responses

```rust
pub fn list_members(ctx: Context) -> Result<Response> {
    let storage = ctx.storage();
    let list = storage.get_str("member_list").unwrap_or_default();
    let members = storage.map::<String, Member>("member");

    let mut result = Vec::new();
    for did in list.split(',') {
        if did.is_empty() { continue; }
        if let Some(m) = members.load(&did.to_string())? {
            result.push(json!({
                "did": m.did,
                "role": m.role,
            }));
        }
    }

    Ok(Response::data(json!({
        "members": result,
        "count": result.len()
    })))
}
```

## API response format

When invoking via HTTP, the full response includes metadata:

```json
{
  "module_id": "my-contract",
  "success": true,
  "result": {
    "is_admin": true,
    "role": "commissioner"
  },
  "gas_consumed": 1200,
  "logs": [
    "[event:AdminChecked]: {\"did\":\"did:key:...\"}"
  ],
  "error": null
}
```

| Field | Description |
|-------|-------------|
| `module_id` | The contract module ID |
| `success` | Whether execution succeeded |
| `result` | The JSON from your `Response` (or error JSON) |
| `gas_consumed` | Total gas units consumed |
| `logs` | All log/event messages emitted |
| `error` | Runtime-level error (usually null on success) |

## Next steps

- [Host Functions](host-functions.md) — Full host function reference
- [Cross-Contract Calls](cross-contract.md) — Calling other contracts
