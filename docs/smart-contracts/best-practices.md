# Best Practices

## Security

### 1. Fail-closed authorization

Always deny by default. Every authorization check should return an error unless explicitly verified:

```rust
// CORRECT
let admin = admins.load(&caller)?
    .filter(|a| !a.revoked)
    .ok_or_else(|| ContractError::Unauthorized("not an admin".into()))?;

// WRONG — silently allows unauthenticated access
let admin = admins.load(&caller)?;
// admin is Option — if None, execution continues without error
```

### 2. Validate before mutating

Put all validation at the top of the function. Never partially mutate state then error:

```rust
pub fn transfer(ctx: Context) -> Result<Response> {
    let from: String = ctx.param("from")?;
    let to: String = ctx.param("to")?;
    let amount: u64 = ctx.param("amount")?;

    // ── All validation first ──
    let from_bal = balances.load(&from)?
        .ok_or_else(|| ContractError::msg("no balance"))?;
    if from_bal < amount {
        return Err(ContractError::msg("insufficient balance"));
    }

    // ── Then mutations ──
    balances.save(&from, &(from_bal - amount))?;
    let to_bal = balances.load(&to)?.unwrap_or(0);
    balances.save(&to, &(to_bal + amount))?;

    Ok(Response::success())
}
```

### 3. Signature message specificity

Make signed messages operation-specific to prevent replay:

```rust
// GOOD — includes operation type and all parameters
let message = format!("assign_admin:{target_did}:{role}:{scope}");

// BAD — generic, could be replayed
let message = format!("approve");
```

### 4. No floating-point

WASM floating-point operations may differ across platforms. Use integer arithmetic only:

```rust
// GOOD — integer basis points (6667 = 66.67%)
let participation_bps = (total_votes * 10000) / eligible_voters;
let met_quorum = participation_bps >= quorum_bps;

// BAD — floating point, non-deterministic
let participation = (total_votes as f64 / eligible as f64) * 100.0;
```

### 5. Bounded loops

Always cap iteration to prevent gas exhaustion:

```rust
// GOOD — bounded
let mut depth = 0u32;
loop {
    if depth > 10 {
        return Err(ContractError::msg("too deep"));
    }
    // ...
    depth += 1;
}

// BAD — unbounded, could loop until gas runs out
loop {
    // ...
}
```

## Gas optimization

### 1. Minimize storage operations

Each `host_store_state` / `host_load_state` call consumes gas. Batch reads/writes:

```rust
// GOOD — load once, mutate in memory, save once
let mut proposal: Proposal = proposals.load(&id)?.unwrap();
proposal.for_votes += 1;
proposal.total_votes += 1;
proposal.last_vote_block = ctx.block_height();
proposals.save(&id, &proposal)?;

// BAD — multiple loads and saves
proposals.load(&id)?.unwrap().for_votes += 1;
proposals.save(&id, &...)?;
proposals.load(&id)?.unwrap().total_votes += 1;
proposals.save(&id, &...)?;
```

### 2. Avoid large responses

Keep response JSON small. Return only what the caller needs:

```rust
// GOOD — concise
Ok(Response::data(json!({"passed": true, "count": 42})))

// BAD — returns entire internal state
Ok(Response::data(json!({
    "passed": true,
    "proposal": proposal,         // Full struct
    "all_votes": all_votes,       // Entire vote history
    "all_proposals": all_props,   // Every proposal ever
})))
```

### 3. Use `opt-level = "s"`

In `Cargo.toml`:

```toml
[profile.release]
opt-level = "s"    # Optimize for binary size
lto = true         # Link-time optimization
```

## Storage design

### 1. Schema versioning

Store a version number to handle future migrations:

```rust
#[derive(Serialize, Deserialize)]
struct Config {
    version: u32,
    admin: String,
    // Future fields use #[serde(default)]
    #[serde(default)]
    max_size: u64,
}
```

### 2. Maintain indexes for enumeration

Since the SDK doesn't provide automatic iteration, maintain a comma-separated index:

```rust
fn add_to_index(storage: &Storage, index_key: &str, value: &str) -> Result<()> {
    let mut list = storage.get_str(index_key).unwrap_or_default();
    if !list.is_empty() { list.push(','); }
    list.push_str(value);
    storage.set_str(index_key, &list)
}
```

### 3. Use meaningful key prefixes

```rust
// GOOD — clear, namespace-like keys
let admins = storage.map::<String, Admin>("admin");
let proposals = storage.map::<String, Proposal>("proposal");
let votes = storage.map::<String, Vote>("vote");

// These produce keys: "admin:did:...", "proposal:id:...", "vote:id:..."
```

## Contract composition

### 1. Keep contracts focused

One responsibility per contract. Use cross-contract calls for composition:

```
admin-registry  ←──  voting-trust (checks admin status)
ctzn-token      ←──  voting-trust (checks citizenship)
admin-registry  ←──  election-admin (checks admin status)
```

### 2. Handle cross-contract failures gracefully

```rust
let result = call_module("other-contract", &params);
match result {
    Some(json) => { /* parse and use */ }
    None => {
        // Contract not found, gas exceeded, or trap
        return Err(ContractError::msg("dependency unavailable"));
    }
}
```

## Error messages

### Be specific but don't leak internals

```rust
// GOOD — helpful for debugging, no sensitive info
return Err(ContractError::msg("proposal not found"));
return Err(ContractError::msg("voting period has ended"));
return Err(ContractError::Unauthorized("not an active admin"));

// BAD — leaks internal state or too vague
return Err(ContractError::msg("error"));           // Too vague
return Err(ContractError::msg(&format!("DB error: {:?}", internal_state)));  // Leaks
```

## Next steps

- [Cheatsheet](cheatsheet.md) — Quick reference card
- [Exercises](exercises/index.md) — Practice with real contracts
