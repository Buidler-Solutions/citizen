# Error Handling

Civitas contracts use Rust's `Result<T>` type for error handling. The SDK's `ContractError` enum covers all common failure cases, and errors are automatically serialized to JSON for the caller.

## Error types

```rust
pub enum ContractError {
    Serde(String),        // Serialization/deserialization failure
    Param(String),        // Missing or invalid parameter
    Unauthorized(String), // Authorization failure
    Storage(String),      // Storage operation failure
    Other(String),        // Generic/custom error
}
```

## The `?` operator

Use `?` to propagate errors automatically. If any step fails, the function returns immediately with the error:

```rust
pub fn transfer(ctx: Context) -> Result<Response> {
    let from: String = ctx.param("from")?;        // Param error → return early
    let to: String = ctx.param("to")?;             // Param error → return early
    let amount: u64 = ctx.param("amount")?;         // Param error → return early

    let balances = ctx.storage().map::<String, u64>("balance");
    let bal: u64 = balances.load(&from)?           // Storage error → return early
        .ok_or_else(|| ContractError::msg("no balance"))?;  // Custom error → return early

    if bal < amount {
        return Err(ContractError::msg("insufficient balance"));  // Explicit error
    }

    Ok(Response::success())
}
```

When an error occurs, the runtime returns:

```json
{"ok": false, "error": "insufficient balance"}
```

## Custom errors

### Using `ContractError::msg()`

```rust
if proposals.exists(&id) {
    return Err(ContractError::msg("proposal already exists"));
}

if block > proposal.end_block {
    return Err(ContractError::msg("voting period has ended"));
}
```

### Using specific error variants

```rust
// Authorization error (caller will see "unauthorized: ...")
return Err(ContractError::Unauthorized("not an active admin".into()));

// Storage error
return Err(ContractError::Storage("failed to write state".into()));

// Generic error
return Err(ContractError::Other("unexpected state".into()));
```

### Error variant mapping

| Variant | Output format | When to use |
|---------|--------------|-------------|
| `ContractError::msg(s)` | `{s}` | General purpose (shortcut for `Other`) |
| `ContractError::Other(s)` | `{s}` | Same as `msg()` |
| `ContractError::Param(s)` | `param: {s}` | Invalid input |
| `ContractError::Unauthorized(s)` | `unauthorized: {s}` | Auth failures |
| `ContractError::Storage(s)` | `storage: {s}` | State failures |
| `ContractError::Serde(s)` | `serde: {s}` | Serialization (usually automatic) |

## Common patterns

### Guard clauses

Put validation at the top of the function, before any state changes:

```rust
pub fn vote(ctx: Context) -> Result<Response> {
    let proposal_id: String = ctx.param("proposal_id")?;
    let voter: String = ctx.param("voter")?;

    // Guards — fail before any mutation
    let proposal: Proposal = ctx.storage()
        .map::<String, Proposal>("proposal")
        .load(&proposal_id)?
        .ok_or_else(|| ContractError::msg("proposal not found"))?;

    if proposal.state != ProposalState::Active {
        return Err(ContractError::msg("proposal is not active"));
    }

    if ctx.block_height() > proposal.end_block {
        return Err(ContractError::msg("voting period has ended"));
    }

    // Only now perform mutations
    proposal.for_votes += 1;
    // ...
    Ok(Response::success())
}
```

### Fail-closed authorization

```rust
// CORRECT: fails if not found
let admin = admins.load(&caller_did)?
    .filter(|a| !a.revoked)
    .ok_or_else(|| ContractError::Unauthorized("not an admin".into()))?;

// WRONG: silently passes if not found
let admin = admins.load(&caller_did)?;
// admin is Option<AdminRecord> — may be None, but no error is raised
```

### Pattern matching for state machines

```rust
match proposal.state {
    ProposalState::Active => {
        // Continue processing
    }
    ProposalState::Passed => {
        return Err(ContractError::msg("proposal already passed"));
    }
    ProposalState::Rejected => {
        return Err(ContractError::msg("proposal was rejected"));
    }
    ProposalState::Executed => {
        return Err(ContractError::msg("proposal already executed"));
    }
    _ => {
        return Err(ContractError::msg("invalid state"));
    }
}
```

## What errors look like to the caller

When a contract returns `Err(e)`, the API response is:

```json
{
  "module_id": "my-contract",
  "success": false,
  "result": {"ok": false, "error": "proposal already exists"},
  "gas_consumed": 850,
  "logs": [],
  "error": null
}
```

The `result` field contains the JSON error string. The `success` field is `false`.

## Panic behavior

Contracts are compiled with a panic handler that enters an infinite loop. In practice, wasmtime detects this as a trap and the execution returns a generic error:

```json
{"ok": false, "error": "wasm execution: trap"}
```

!!! warning "Avoid panics"
    Panics consume all gas and don't give useful error messages. Always use `Result<T>` and explicit error returns instead of `unwrap()`, `expect()`, or array indexing without bounds checks.

    ```rust
    // BAD — will panic if missing
    let val = my_vec[5];

    // GOOD — explicit error
    let val = my_vec.get(5)
        .ok_or_else(|| ContractError::msg("index out of bounds"))?;
    ```

## Next steps

- [Responses](responses.md) — Building successful return values
- [Host Functions](host-functions.md) — Full host function reference
