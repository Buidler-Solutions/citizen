# Cross-Contract Calls

Contracts can call other activated contracts using the `call_module` host function. This enables composition — a governance contract can check token ownership, a voting contract can query an admin registry.

## Basic usage

```rust
use citizen_contract_sdk::prelude::*;

pub fn check_eligibility(ctx: Context) -> Result<Response> {
    let voter_did: String = ctx.param("did")?;

    // Call the ctzn-token contract to check citizenship
    let result = call_module(
        "ctzn-token",
        &serde_json::to_string(&json!({
            "operation": "check_access",
            "did": voter_did
        })).unwrap_or_default()
    );

    match result {
        Some(response_json) => {
            let response: serde_json::Value = serde_json::from_str(&response_json)
                .map_err(|e| ContractError::msg(&format!("invalid response: {e}")))?;

            let has_access = response.get("has_access")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            Ok(Response::data(json!({"eligible": has_access})))
        }
        None => Err(ContractError::msg("cross-contract call failed"))
    }
}
```

## How it works

```
Contract A                          Host (Node)                    Contract B
───────────                         ──────────                     ───────────
call_module("B", params)
                 ────────────────►  host_call_module()
                                   1. Check B is activated
                                   2. Load B's WASM bytecode
                                   3. Create new wasm instance
                                   4. Call B's handle()            handle(params)
                                   5. Deduct gas from A's budget        │
                                   6. Enforce call depth limit          │
                 ◄────────────────  7. Return B's response          ◄───
parse response
```

## Call depth limits

The execution engine enforces a maximum call depth (default: 4) to prevent infinite recursion:

```
Contract A calls Contract B calls Contract C calls Contract D
     Depth 1           Depth 2           Depth 3           Depth 4

Contract D calls Contract E → ERROR: max call depth exceeded
```

| Setting | Default | Configured in |
|---------|---------|---------------|
| `max_call_depth` | 4 | `ExecutionConfig` |
| `cross_call_gas_limit` | 500,000 | `ExecutionConfig` |

## Pattern: Token-gated operation

```rust
pub fn privileged_action(ctx: Context) -> Result<Response> {
    let did: String = ctx.param("did")?;

    // Check if the caller holds a qualifying CTZN token
    let result = call_module("ctzn-token", &json!({
        "operation": "check_access",
        "did": did,
        "required_tier": "silver"
    }).to_string());

    let has_token = result
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("has_access").and_then(|a| a.as_bool()))
        .unwrap_or(false);

    if !has_token {
        return Err(ContractError::Unauthorized(
            "caller does not hold a qualifying token".into()
        ));
    }

    // Proceed with privileged action
    Ok(Response::success())
}
```

## Pattern: Admin registry integration

```rust
pub fn admin_action(ctx: Context) -> Result<Response> {
    let did: String = ctx.param("did")?;

    // Query the admin-registry contract
    let result = call_module("admin-registry", &json!({
        "operation": "check_admin",
        "did": did
    }).to_string());

    let is_admin = result
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("is_admin").and_then(|a| a.as_bool()))
        .unwrap_or(false);

    if !is_admin {
        return Err(ContractError::Unauthorized("not an admin".into()));
    }

    Ok(Response::success())
}
```

## Pattern: Composing results

```rust
pub fn get_full_profile(ctx: Context) -> Result<Response> {
    let did: String = ctx.param("did")?;

    // Query citizenship status
    let citizen_result = call_module("ctzn-token", &json!({
        "operation": "check_access", "did": &did
    }).to_string());

    // Query admin status
    let admin_result = call_module("admin-registry", &json!({
        "operation": "check_admin", "did": &did
    }).to_string());

    // Combine results
    let is_citizen = citizen_result
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("has_access").and_then(|a| a.as_bool()))
        .unwrap_or(false);

    let is_admin = admin_result
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("is_admin").and_then(|a| v.as_bool()))
        .unwrap_or(false);

    Ok(Response::data(json!({
        "did": did,
        "citizen": is_citizen,
        "admin": is_admin,
        "profile": {
            "can_vote": is_citizen,
            "can_administer": is_admin
        }
    })))
}
```

## Error handling for cross-contract calls

Cross-contract calls can fail in several ways:

```rust
match call_module("other-contract", &params) {
    Some(response_json) => {
        // Success — parse the response
        let response: serde_json::Value = serde_json::from_str(&response_json)
            .map_err(|e| ContractError::msg(&format!("bad response: {e}")))?;

        if response.get("ok").and_then(|v| v.as_bool()) == Some(false) {
            let error = response.get("error").and_then(|v| v.as_str()).unwrap_or("unknown");
            return Err(ContractError::msg(&format!("target contract error: {error}")));
        }

        // Use response data
        Ok(Response::data(response))
    }
    None => {
        // The call itself failed (module not found, gas exceeded, trap)
        Err(ContractError::msg("cross-contract call failed"))
    }
}
```

## Gas considerations

Gas consumed by the called contract is deducted from the **caller's** gas budget. This means:

- A chain of 4 cross-contract calls shares one gas pool
- If any contract in the chain runs out of gas, the entire chain fails
- The `cross_call_gas_limit` setting caps how much gas a single call can consume

## Next steps

- [Deployment](deployment.md) — How to register and activate contracts
- [Best Practices](best-practices.md) — Gas optimization and security patterns
