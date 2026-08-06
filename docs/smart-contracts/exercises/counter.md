# Exercise 1: Counter

Build a simple counter contract that increments, decrements, and resets a number. This exercise practices basic storage, events, and responses.

## Problem statement

Create a contract with the following operations:

| Operation | Parameters | Behavior |
|-----------|-----------|----------|
| `increment` | — | Add 1 to the counter |
| `decrement` | — | Subtract 1 from the counter (minimum 0) |
| `reset` | — | Set counter to 0 |
| `get_count` | — | Return the current count |
| `set_count` | `value: u64` | Set counter to an exact value |

### Requirements

1. Counter starts at 0
2. Decrement cannot go below 0 (return an error if it would)
3. Emit an event on every mutation
4. `get_count` returns `{"count": N}`
5. All mutations return the new count

## Starter code

```rust
#![no_std]
#![no_main]

extern crate alloc;

#[global_allocator]
static ALLOC: citizen_contract_sdk::Allocator = citizen_contract_sdk::Allocator;

use citizen_contract_sdk::prelude::*;
use citizen_contract_derive::contract;

#[contract]
mod contract {
    use super::*;

    // TODO: implement increment
    pub fn increment(ctx: Context) -> Result<Response> {
        todo!()
    }

    // TODO: implement decrement
    pub fn decrement(ctx: Context) -> Result<Response> {
        todo!()
    }

    // TODO: implement reset
    pub fn reset(ctx: Context) -> Result<Response> {
        todo!()
    }

    // TODO: implement get_count
    pub fn get_count(ctx: Context) -> Result<Response> {
        todo!()
    }

    // TODO: implement set_count
    pub fn set_count(ctx: Context) -> Result<Response> {
        todo!()
    }
}
```

## Hints

??? tip "Hint 1: Storage pattern"
    Use `ctx.storage().item::<u64>("count")` for the counter value. The `update()` method does read-modify-write automatically:
    ```rust
    let counter = ctx.storage().item::<u64>("count");
    let new_val = counter.update(|v| v + 1)?;
    ```

??? tip "Hint 2: Decrement guard"
    Check the current value before subtracting. Return an error if it's already 0:
    ```rust
    let counter = ctx.storage().item::<u64>("count");
    let current = counter.load()?.unwrap_or(0);
    if current == 0 {
        return Err(ContractError::msg("counter is already at 0"));
    }
    counter.save(&(current - 1))?;
    ```

??? tip "Hint 3: Emitting events"
    Use `ctx.emit()` with the event name and JSON data:
    ```rust
    ctx.emit("CounterChanged", &json!({"new_value": new_val, "action": "increment"}));
    ```

??? tip "Hint 4: set_count parameter"
    Use `ctx.param("value")?` to extract the required parameter:
    ```rust
    let value: u64 = ctx.param("value")?;
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

#[contract]
mod contract {
    use super::*;

    pub fn increment(ctx: Context) -> Result<Response> {
        let counter = ctx.storage().item::<u64>("count");
        let new_val = counter.update(|v| v + 1)?;
        ctx.emit("CounterChanged", &json!({
            "action": "increment",
            "new_value": new_val,
            "block": ctx.block_height()
        }));
        Ok(Response::data(json!({"count": new_val})))
    }

    pub fn decrement(ctx: Context) -> Result<Response> {
        let counter = ctx.storage().item::<u64>("count");
        let current = counter.load()?.unwrap_or(0);

        if current == 0 {
            return Err(ContractError::msg("counter is already at 0"));
        }

        let new_val = current - 1;
        counter.save(&new_val)?;

        ctx.emit("CounterChanged", &json!({
            "action": "decrement",
            "new_value": new_val,
            "block": ctx.block_height()
        }));

        Ok(Response::data(json!({"count": new_val})))
    }

    pub fn reset(ctx: Context) -> Result<Response> {
        ctx.storage().item::<u64>("count").save(&0)?;
        ctx.emit("CounterReset", &json!({
            "block": ctx.block_height()
        }));
        Ok(Response::data(json!({"count": 0})))
    }

    pub fn get_count(ctx: Context) -> Result<Response> {
        let count: u64 = ctx.storage().item::<u64>("count").load()?.unwrap_or(0);
        Ok(Response::data(json!({"count": count})))
    }

    pub fn set_count(ctx: Context) -> Result<Response> {
        let value: u64 = ctx.param("value")?;
        ctx.storage().item::<u64>("count").save(&value)?;
        ctx.emit("CounterChanged", &json!({
            "action": "set",
            "new_value": value,
            "block": ctx.block_height()
        }));
        Ok(Response::data(json!({"count": value})))
    }
}
```

## Test cases

```python
#!/usr/bin/env python3
"""Integration test for counter exercise."""
import json, urllib.request

BASE = "http://127.0.0.1:8091"

def execute(module_id, params):
    data = json.dumps(params).encode()
    req = urllib.request.Request(
        f"{BASE}/api/v1/modules/{module_id}/execute",
        data=data, headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req).read())

# Test 1: Initial count is 0
result = execute("counter", {"operation": "get_count"})
assert result["result"]["count"] == 0, f"Expected 0, got {result['result']['count']}"
print("✓ Initial count is 0")

# Test 2: Increment
result = execute("counter", {"operation": "increment"})
assert result["result"]["count"] == 1
print("✓ After increment: 1")

# Test 3: Increment again
result = execute("counter", {"operation": "increment"})
assert result["result"]["count"] == 2
print("✓ After second increment: 2")

# Test 4: Decrement
result = execute("counter", {"operation": "decrement"})
assert result["result"]["count"] == 1
print("✓ After decrement: 1")

# Test 5: Set count
result = execute("counter", {"operation": "set_count", "value": 100})
assert result["result"]["count"] == 100
print("✓ After set_count 100: 100")

# Test 6: Reset
result = execute("counter", {"operation": "reset"})
assert result["result"]["count"] == 0
print("✓ After reset: 0")

# Test 7: Decrement at 0 should fail
result = execute("counter", {"operation": "decrement"})
assert not result["success"], "Decrement at 0 should have failed"
print("✓ Decrement at 0 correctly fails")

# Test 8: Missing required parameter
result = execute("counter", {"operation": "set_count"})
assert not result["success"], "Missing 'value' should have failed"
print("✓ Missing 'value' parameter correctly fails")

# Test 9: Events are emitted
result = execute("counter", {"operation": "increment"})
assert any("CounterChanged" in log for log in result.get("logs", []))
print("✓ Event emitted on increment")

print("\nAll tests passed!")
```

## Key concepts learned

- **`Item<T>` with `update()`** — Read-modify-write for single values
- **`unwrap_or(0)`** — Handle missing state gracefully (default to 0)
- **Guard clauses** — Validate before mutating (decrement check)
- **`ctx.emit()`** — Structured events with block height
- **`ctx.param()`** — Required parameter extraction with error propagation

## Next exercise

[Exercise 2: Token →](token.md)
