# Testing

Testing Citizen smart contracts involves two levels: unit testing individual logic functions, and integration testing against a running node.

## Unit testing

Contract functions take a `Context` and return `Result<Response>`. You can test the internal logic by extracting pure functions and testing those with standard Rust tests.

### Approach: Separate logic from contract

```rust
// src/lib.rs
#![no_std]
#![no_main]
extern crate alloc;

#[global_allocator]
static ALLOC: citizen_contract_sdk::Allocator = citizen_contract_sdk::Allocator;

use citizen_contract_sdk::prelude::*;
use citizen_contract_derive::contract;

// Pure logic function (testable without WASM)
pub fn calculate_quorum(for_votes: u64, against_votes: u64, eligible: u64, quorum_bps: u32) -> bool {
    let total = for_votes + against_votes;
    if eligible == 0 { return false; }
    let participation = (total * 10000) / eligible;
    participation >= quorum_bps as u64 && for_votes > against_votes
}

// Contract operation (calls the pure function)
#[contract]
mod contract {
    use super::*;

    pub fn finalize(ctx: Context) -> Result<Response> {
        let proposal_id: String = ctx.param("proposal_id")?;
        let proposal: Proposal = ctx.storage()
            .map::<String, Proposal>("proposal")
            .load(&proposal_id)?
            .ok_or_else(|| ContractError::msg("not found"))?;

        let passed = calculate_quorum(
            proposal.for_votes,
            proposal.against_votes,
            100,
            proposal.quorum_bps,
        );

        Ok(Response::data(json!({"passed": passed})))
    }
}
```

### Test the pure logic

```rust
// tests/logic.rs
use my_contract::calculate_quorum;

#[test]
fn quorum_met_with_majority() {
    assert!(calculate_quorum(70, 30, 100, 6667));  // 100% turnout, majority
}

#[test]
fn quorum_not_met_low_turnout() {
    assert!(!calculate_quorum(40, 10, 100, 6667));  // 50% turnout < 66.67%
}

#[test]
fn quorum_met_but_minority() {
    assert!(!calculate_quorum(30, 70, 100, 6667));  // 100% turnout but minority
}
```

Run: `cargo test --test logic`

!!! note "These tests run natively, not in WASM"
    Test files use `std` — they run as normal Rust binaries against the pure logic functions exported from your contract crate.

## Integration testing

### Using the local stack

Start a local node:

```bash
bash scripts/start-local-stack.sh
```

### Python integration test

```python
#!/usr/bin/env python3
"""Integration test: deploy counter, increment, verify."""
import json, urllib.request

BASE = "http://127.0.0.1:8091"

def execute(module_id, params):
    data = json.dumps(params).encode()
    req = urllib.request.Request(
        f"{BASE}/api/v1/modules/{module_id}/execute",
        data=data,
        headers={"Content-Type": "application/json"},
    )
    resp = urllib.request.urlopen(req)
    return json.loads(resp.read())

# Test: get_count returns 0 initially
result = execute("counter", {"operation": "get_count"})
assert result["success"] is True
assert result["result"]["count"] == 0, f"Expected 0, got {result['result']['count']}"
print("✓ Initial count is 0")

# Test: increment
result = execute("counter", {"operation": "increment"})
assert result["success"] is True
assert result["result"]["count"] == 1
print("✓ After increment: 1")

# Test: increment_by 5
result = execute("counter", {"operation": "increment_by", "amount": 5})
assert result["result"]["count"] == 6
print("✓ After increment_by 5: 6")

# Test: reset
result = execute("counter", {"operation": "reset"})
assert result["success"] is True
result = execute("counter", {"operation": "get_count"})
assert result["result"]["count"] == 0
print("✓ After reset: 0")

print("\nAll tests passed!")
```

### Shell-based smoke test

```bash
#!/bin/bash
set -e
BASE="http://127.0.0.1:8091"

echo "Testing counter contract..."

# Increment
RESULT=$(curl -s -X POST "$BASE/api/v1/modules/counter/execute" \
  -H "Content-Type: application/json" \
  -d '{"operation": "increment"}')

SUCCESS=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['success'])")
if [ "$SUCCESS" != "True" ]; then
  echo "FAIL: increment did not succeed"
  exit 1
fi
echo "PASS: increment"

# Verify
RESULT=$(curl -s -X POST "$BASE/api/v1/modules/counter/execute" \
  -H "Content-Type: application/json" \
  -d '{"operation": "get_count"}')

COUNT=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['count'])")
if [ "$COUNT" != "1" ]; then
  echo "FAIL: expected count=1, got $COUNT"
  exit 1
fi
echo "PASS: count is $COUNT"

echo "All tests passed!"
```

## Test checklist

Before deploying a contract, verify:

- [ ] All pure logic functions have unit tests
- [ ] Error paths are tested (missing params, invalid state, unauthorized callers)
- [ ] Edge cases: empty values, maximum sizes, boundary conditions
- [ ] Integration test: contract deploys and activates successfully
- [ ] Integration test: each operation returns expected JSON
- [ ] Integration test: state persists across invocations
- [ ] Gas consumption is reasonable (check `gas_consumed` in responses)

## Next steps

- [Best Practices](best-practices.md) — Security, gas, and design patterns
- [Cheatsheet](cheatsheet.md) — Quick reference
