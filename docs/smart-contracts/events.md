# Events

Events are structured log messages emitted during contract execution. They appear in node logs, execution receipts, and can be indexed by external services.

## Emitting events

```rust
pub fn transfer(ctx: Context) -> Result<Response> {
    let from: String = ctx.param("from")?;
    let to: String = ctx.param("to")?;
    let amount: u64 = ctx.param("amount")?;

    // ... transfer logic ...

    ctx.emit("Transfer", &json!({
        "from": from,
        "to": to,
        "amount": amount,
        "block": ctx.block_height()
    }));

    Ok(Response::success())
}
```

### Event format

Events are emitted as log messages with a structured prefix:

```
[event:Transfer]: {"from":"did:key:...","to":"did:key:...","amount":100,"block":42}
```

### Viewing events

Events appear in:

1. **Node logs** — visible in the node's stdout/tracing output
2. **Execution result** — the `logs` array in the API response:
   ```json
   {
     "module_id": "my-contract",
     "success": true,
     "result": {"ok": true},
     "gas_consumed": 1500,
     "logs": [
       "[event:Transfer]: {\"from\":\"did:key:...\",\"to\":\"did:key:...\",\"amount\":100}"
     ]
   }
   ```
3. **Explorer** — execution receipts include log output

## Event naming conventions

Follow a consistent naming pattern:

| Convention | Example |
|-----------|---------|
| Past tense for state changes | `Transfer`, `AdminAssigned`, `ProposalFinalized` |
| Present tense for queries/actions | `Voting`, `Delegation` |
| Include entity name | `TokenMinted`, `TokenBurned` (not just `Minted`) |

## Event data patterns

### Include block height for ordering

```rust
ctx.emit("VoteCast", &json!({
    "proposal": proposal_id,
    "voter": voter,
    "support": support,
    "weight": weight,
    "block": ctx.block_height()  // For ordering and block-based queries
}));
```

### Include the actor for indexing

```rust
ctx.emit("AdminAssigned", &json!({
    "admin": target_did,
    "role": role,
    "scope": scope,
    "assigned_by": admin_did,  // Who performed the action
    "block": ctx.block_height()
}));
```

### State machine transitions

```rust
ctx.emit("ProposalFinalized", &json!({
    "id": proposal_id,
    "old_state": "Active",
    "new_state": "Passed",
    "for_votes": 150,
    "against_votes": 30,
    "block": ctx.block_height()
}));
```

## Multiple events per operation

You can emit multiple events in a single operation:

```rust
pub fn batch_assign(ctx: Context) -> Result<Response> {
    let admin_did: String = ctx.param("admin_did")?;
    let targets: Vec<String> = ctx.param("targets")?;

    for target in &targets {
        // ... assign logic ...
        ctx.emit("AdminAssigned", &json!({
            "admin": target,
            "assigned_by": admin_did
        }));
    }

    ctx.emit("BatchComplete", &json!({
        "count": targets.len(),
        "by": admin_did
    }));

    Ok(Response::success())
}
```

## Low-level logging

For debug messages that aren't events:

```rust
use citizen_contract_sdk::prelude::*;

pub fn debug_op(ctx: Context) -> Result<Response> {
    log_str("starting operation");

    // ... logic ...

    log_str(&format!("processed {} items", count));

    Ok(Response::success())
}
```

!!! note "Logs are public"
    All log output is visible in execution receipts. Never log sensitive data like private keys or decrypted payloads.

## Next steps

- [Error Handling](errors.md) — Proper error patterns
- [Responses](responses.md) — Building return values
