# Exercise 2: Token

Build a fungible token contract with mint, transfer, and balance query. This exercise practices maps, arithmetic, validation-before-mutation, and enumeration.

## Problem statement

Create a token contract with the following operations:

| Operation | Parameters | Behavior |
|-----------|-----------|----------|
| `mint` | `to: String`, `amount: u64` | Create new tokens for a recipient |
| `transfer` | `from: String`, `to: String`, `amount: u64` | Move tokens between holders |
| `balance_of` | `did: String` | Return the holder's balance |
| `total_supply` | — | Return total tokens minted |
| `list_holders` | — | Return all token holders and balances |

### Requirements

1. Only the contract owner can mint new tokens (set at deployment)
2. Transfers fail if the sender has insufficient balance
3. Balances cannot go negative (use `u64`, check before subtracting)
4. Track total supply across all mints
5. Maintain a holder index for enumeration
6. Emit `Transfer` and `Mint` events
7. The contract owner is set via a `configure` operation requiring governance approval

## Starter code

```rust
#![no_std]
#![no_main]

extern crate alloc;

#[global_allocator]
static ALLOC: citizen_contract_sdk::Allocator = citizen_contract_sdk::Allocator;

use citizen_contract_sdk::prelude::*;
use citizen_contract_derive::contract;
use serde::{Serialize, Deserialize};

// TODO: Define any needed types

#[contract]
mod contract {
    use super::*;

    // TODO: configure (governance-gated, sets owner)
    pub fn configure(ctx: Context) -> Result<Response> {
        todo!()
    }

    // TODO: mint (owner only)
    pub fn mint(ctx: Context) -> Result<Response> {
        todo!()
    }

    // TODO: transfer
    pub fn transfer(ctx: Context) -> Result<Response> {
        todo!()
    }

    // TODO: balance_of
    pub fn balance_of(ctx: Context) -> Result<Response> {
        todo!()
    }

    // TODO: total_supply
    pub fn total_supply(ctx: Context) -> Result<Response> {
        todo!()
    }

    // TODO: list_holders
    pub fn list_holders(ctx: Context) -> Result<Response> {
        todo!()
    }
}
```

## Hints

??? tip "Hint 1: Storage layout"
    Use these storage keys:
    - `"owner"` — The contract owner DID (set during `configure`)
    - `"total_supply"` — Total tokens minted (`Item<u64>`)
    - `"balance:<did>"` — Per-holder balance (use a `Map<String, u64>`)
    - `"holder_list"` — Comma-separated list of all holder DIDs

??? tip "Hint 2: Owner check"
    After `configure`, verify the caller is the owner before allowing `mint`:
    ```rust
    let owner = ctx.storage().get_str("owner")
        .ok_or_else(|| ContractError::msg("not configured"))?;
    if caller_did != owner {
        return Err(ContractError::Unauthorized("only owner can mint".into()));
    }
    ```

??? tip "Hint 3: Transfer validation"
    Check balance BEFORE modifying any state:
    ```rust
    let from_bal = balances.load(&from)?.unwrap_or(0);
    if from_bal < amount {
        return Err(ContractError::msg("insufficient balance"));
    }
    // Only now modify state
    ```

??? tip "Hint 4: Holder index"
    When minting to a new holder, add them to the index:
    ```rust
    let mut list = ctx.storage().get_str("holder_list").unwrap_or_default();
    if !list.split(',').any(|d| d == &to) {
        if !list.is_empty() { list.push(','); }
        list.push_str(&to);
        ctx.storage().set_str("holder_list", &list)?;
    }
    ```

??? tip "Hint 5: Updating total supply"
    ```rust
    let supply = ctx.storage().item::<u64>("total_supply");
    let new_supply = supply.update(|v| v + amount)?;
    ```

## Complete solution

```rust
#![no_std]
#![no_main]

extern crate alloc;

#[global_allocator]
static ALLOC: citizen_contract_sdk::Allocator = citizen_contract_sdk::Allocator;

use citizen_contract_sdk::prelude::*;
use citizen_contract_derive::contract;
use serde::{Serialize, Deserialize};

#[derive(Serialize, Deserialize)]
struct Holder {
    did: String,
    balance: u64,
}

#[contract]
mod contract {
    use super::*;

    pub fn configure(ctx: Context) -> Result<Response> {
        let proposal_id: String = ctx.param("proposal_id")?;
        let owner: String = ctx.param("owner")?;

        // Governance gate — prevents unauthorized setup
        ctx.require_governance(&proposal_id)?;

        // Prevent reconfiguration
        if ctx.storage().exists("owner") {
            return Err(ContractError::msg("already configured"));
        }

        ctx.storage().set_str("owner", &owner)?;
        ctx.storage().item::<u64>("total_supply").save(&0)?;

        ctx.emit("TokenConfigured", &json!({"owner": owner}));
        Ok(Response::success())
    }

    pub fn mint(ctx: Context) -> Result<Response> {
        let to: String = ctx.param("to")?;
        let amount: u64 = ctx.param("amount")?;

        // Owner check
        let owner = ctx.storage().get_str("owner")
            .ok_or_else(|| ContractError::msg("not configured"))?;

        // In a real contract, verify the owner's signature here.
        // For this exercise, we pass owner_did as a parameter.
        let caller: String = ctx.param("caller")?;
        if caller != owner {
            return Err(ContractError::Unauthorized("only owner can mint".into()));
        }

        if amount == 0 {
            return Err(ContractError::msg("amount must be > 0"));
        }

        let storage = ctx.storage();
        let balances = storage.map::<String, u64>("balance");

        // Update recipient balance
        let current = balances.load(&to)?.unwrap_or(0);
        balances.save(&to, &(current + amount))?;

        // Update total supply
        let supply = storage.item::<u64>("total_supply");
        let new_supply = supply.update(|v| v + amount)?;

        // Add to holder index if new
        let mut list = storage.get_str("holder_list").unwrap_or_default();
        if !list.split(',').any(|d| d == &to) {
            if !list.is_empty() { list.push(','); }
            list.push_str(&to);
            storage.set_str("holder_list", &list)?;
        }

        ctx.emit("Mint", &json!({
            "to": to,
            "amount": amount,
            "total_supply": new_supply,
            "block": ctx.block_height()
        }));

        Ok(Response::data(json!({
            "to": to,
            "amount": amount,
            "balance": current + amount
        })))
    }

    pub fn transfer(ctx: Context) -> Result<Response> {
        let from: String = ctx.param("from")?;
        let to: String = ctx.param("to")?;
        let amount: u64 = ctx.param("amount")?;

        if amount == 0 {
            return Err(ContractError::msg("amount must be > 0"));
        }

        let balances = ctx.storage().map::<String, u64>("balance");

        // ── Validation before mutation ──
        let from_bal = balances.load(&from)?.unwrap_or(0);
        if from_bal < amount {
            return Err(ContractError::msg("insufficient balance"));
        }

        let to_bal = balances.load(&to)?.unwrap_or(0);

        // ── Mutate ──
        balances.save(&from, &(from_bal - amount))?;
        balances.save(&to, &(to_bal + amount))?;

        // Add recipient to holder index if new
        let storage = ctx.storage();
        let mut list = storage.get_str("holder_list").unwrap_or_default();
        if !list.split(',').any(|d| d == &to) {
            if !list.is_empty() { list.push(','); }
            list.push_str(&to);
            storage.set_str("holder_list", &list)?;
        }

        ctx.emit("Transfer", &json!({
            "from": from,
            "to": to,
            "amount": amount,
            "block": ctx.block_height()
        }));

        Ok(Response::data(json!({
            "from": from,
            "to": to,
            "amount": amount,
            "from_balance": from_bal - amount,
            "to_balance": to_bal + amount
        })))
    }

    pub fn balance_of(ctx: Context) -> Result<Response> {
        let did: String = ctx.param("did")?;
        let balance = ctx.storage()
            .map::<String, u64>("balance")
            .load(&did)?
            .unwrap_or(0);

        Ok(Response::data(json!({
            "did": did,
            "balance": balance
        })))
    }

    pub fn total_supply(ctx: Context) -> Result<Response> {
        let supply: u64 = ctx.storage()
            .item::<u64>("total_supply")
            .load()?
            .unwrap_or(0);

        Ok(Response::data(json!({"total_supply": supply})))
    }

    pub fn list_holders(ctx: Context) -> Result<Response> {
        let storage = ctx.storage();
        let list = storage.get_str("holder_list").unwrap_or_default();
        let balances = storage.map::<String, u64>("balance");

        let mut holders = Vec::new();
        for did in list.split(',') {
            if did.is_empty() { continue; }
            let balance = balances.load(&did.to_string())?.unwrap_or(0);
            holders.push(json!({
                "did": did,
                "balance": balance
            }));
        }

        Ok(Response::data(json!({
            "holders": holders,
            "count": holders.len()
        })))
    }
}
```

## Test cases

```python
#!/usr/bin/env python3
"""Integration test for token exercise."""
import json, urllib.request

BASE = "http://127.0.0.1:8091"
OWNER = "did:key:ed25519:owner"

def execute(module_id, params):
    data = json.dumps(params).encode()
    req = urllib.request.Request(
        f"{BASE}/api/v1/modules/{module_id}/execute",
        data=data, headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req).read())

# Configure (requires governance approval — see deployment script)
# result = execute("token", {"operation": "configure", "proposal_id": "...", "owner": OWNER})

# Test 1: Mint tokens
result = execute("token", {
    "operation": "mint", "to": "did:key:alice", "amount": 1000, "caller": OWNER
})
assert result["success"]
assert result["result"]["balance"] == 1000
print("✓ Minted 1000 to alice")

# Test 2: Balance check
result = execute("token", {"operation": "balance_of", "did": "did:key:alice"})
assert result["result"]["balance"] == 1000
print("✓ Alice balance: 1000")

# Test 3: Transfer
result = execute("token", {
    "operation": "transfer", "from": "did:key:alice", "to": "did:key:bob", "amount": 300
})
assert result["result"]["from_balance"] == 700
assert result["result"]["to_balance"] == 300
print("✓ Transferred 300 alice → bob")

# Test 4: Insufficient balance
result = execute("token", {
    "operation": "transfer", "from": "did:key:bob", "to": "did:key:alice", "amount": 500
})
assert not result["success"], "Should fail — bob only has 300"
print("✓ Insufficient balance correctly rejected")

# Test 5: Total supply
result = execute("token", {"operation": "total_supply"})
assert result["result"]["total_supply"] == 1000
print("✓ Total supply: 1000")

# Test 6: List holders
result = execute("token", {"operation": "list_holders"})
assert result["result"]["count"] == 2
print(f"✓ Listed {result['result']['count']} holders")

# Test 7: Non-owner mint fails
result = execute("token", {
    "operation": "mint", "to": "did:key:eve", "amount": 100, "caller": "did:key:eve"
})
assert not result["success"]
print("✓ Non-owner mint correctly rejected")

# Test 8: Zero amount fails
result = execute("token", {
    "operation": "transfer", "from": "did:key:alice", "to": "did:key:bob", "amount": 0
})
assert not result["success"]
print("✓ Zero amount transfer correctly rejected")

print("\nAll tests passed!")
```

## Key concepts learned

- **`Map<K, V>` for balances** — Keyed lookups with typed values
- **Validation before mutation** — Check all conditions before changing state
- **Owner pattern** — Single privileged account set during governance-gated configuration
- **Enumeration index** — Comma-separated holder list for iteration
- **Total supply tracking** — Separate counter updated on each mint
- **Events with context** — Include relevant parties and amounts

## Next exercise

[Exercise 3: Access Control →](access-control.md)
