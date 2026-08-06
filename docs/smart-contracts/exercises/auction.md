# Exercise 6: Auction

Build a time-locked auction contract where users place bids and the highest bidder wins when the auction ends. This is the most advanced exercise — it combines time-based logic, complex state transitions, validation chains, and edge case handling.

## Problem statement

Create an auction contract with the following operations:

| Operation | Parameters | Behavior |
|-----------|-----------|----------|
| `create_auction` | `auction_id`, `item`, `seller`, `duration?`, `min_bid?` | Create a new open auction |
| `bid` | `auction_id`, `bidder`, `amount` | Place a bid (must exceed current highest) |
| `end_auction` | `auction_id` | Close the auction and determine the winner |
| `get_auction` | `auction_id` | Return auction details |
| `list_auctions` | — | List all auctions with status summaries |

### Auction lifecycle

```
   create_auction()
        │
        ▼
  ┌── Open ───────────────────────────┐
  │                                    │
  │   bid() — must beat highest        │
  │   │                                │
  │   ▼                                │
  │   (still Open, new high bidder)    │
  │                                    │
  └──────────────┬─────────────────────┘
                 │
          end_auction()
          (block > end_block)
                 │
                 ▼
      ┌───── Ended ──────┐
      │                   │
      │  had bids?        │
      ├── yes ──┐  no ────┤
      │         │          │
      ▼         ▼          ▼
   Sold    Winner set   Cancelled
            (no winner)
```

### Requirements

1. Auctions start in `Open` state
2. `bid` requires `amount > current_highest_bid` (or ≥ `min_bid` if first bid)
3. `bid` requires `block_height <= end_block`
4. `end_auction` requires `block_height > end_block`
5. Track the previous highest bidder (for refund logic in production)
6. `min_bid` defaults to 1
7. `duration` defaults to 1000 blocks
8. Cancelled auctions have no winner
9. Use a comma-separated index for `list_auctions`
10. Emit events on create, bid, and end

### Edge cases to handle

- Bid on a non-existent auction → error
- Bid on an ended auction → error
- Bid equal to or lower than current highest → error
- End an auction that's already ended → error
- End an auction before the deadline → error
- End an auction with zero bids → `Cancelled` state

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

// TODO: Define AuctionState and Auction types

#[contract]
mod contract {
    use super::*;

    // TODO: create_auction
    pub fn create_auction(ctx: Context) -> Result<Response> {
        todo!()
    }

    // TODO: bid
    pub fn bid(ctx: Context) -> Result<Response> {
        todo!()
    }

    // TODO: end_auction
    pub fn end_auction(ctx: Context) -> Result<Response> {
        todo!()
    }

    // TODO: get_auction
    pub fn get_auction(ctx: Context) -> Result<Response> {
        todo!()
    }

    // TODO: list_auctions
    pub fn list_auctions(ctx: Context) -> Result<Response> {
        todo!()
    }
}
```

## Hints

??? tip "Hint 1: Data types"
    ```rust
    #[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
    enum AuctionState {
        Open,
        Sold,
        Cancelled,
    }

    #[derive(Serialize, Deserialize)]
    struct Auction {
        id: String,
        item: String,
        seller: String,
        state: AuctionState,
        highest_bidder: Option<String>,
        highest_bid: u64,
        min_bid: u64,
        start_block: u64,
        end_block: u64,
        bid_count: u64,
    }
    ```

??? tip "Hint 2: Bid validation chain"
    Check all conditions before mutating:
    ```rust
    // 1. Auction exists and is open
    // 2. Auction hasn't ended (block <= end_block)
    // 3. Bid exceeds current highest (or min_bid for first bid)
    let min_required = if auction.highest_bid > 0 {
        auction.highest_bid + 1  // Must strictly exceed
    } else {
        auction.min_bid
    };
    if amount < min_required {
        return Err(ContractError::msg("bid too low"));
    }
    ```

??? tip "Hint 3: End auction logic"
    ```rust
    if ctx.block_height() <= auction.end_block {
        return Err(ContractError::msg("auction still active"));
    }
    auction.state = if auction.highest_bidder.is_some() {
        AuctionState::Sold
    } else {
        AuctionState::Cancelled
    };
    ```

??? tip "Hint 4: Handling Option in structs"
    The highest bidder starts as `None`:
    ```rust
    // First bid
    auction.highest_bidder = Some(bidder.clone());
    auction.highest_bid = amount;
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

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
enum AuctionState {
    Open,
    Sold,
    Cancelled,
}

#[derive(Serialize, Deserialize)]
struct Auction {
    id: String,
    item: String,
    seller: String,
    state: AuctionState,
    highest_bidder: Option<String>,
    highest_bid: u64,
    min_bid: u64,
    start_block: u64,
    end_block: u64,
    bid_count: u64,
}

#[contract]
mod contract {
    use super::*;

    pub fn create_auction(ctx: Context) -> Result<Response> {
        let id: String = ctx.param("auction_id")?;
        let item: String = ctx.param("item")?;
        let seller: String = ctx.param("seller")?;
        let duration: u64 = ctx.param_or("duration", 1000);
        let min_bid: u64 = ctx.param_or("min_bid", 1);

        let auctions = ctx.storage().map::<String, Auction>("auction");

        // No duplicates
        if auctions.exists(&id) {
            return Err(ContractError::msg("auction already exists"));
        }

        if min_bid == 0 {
            return Err(ContractError::msg("min_bid must be > 0"));
        }

        let block = ctx.block_height();

        let auction = Auction {
            id: id.clone(),
            item: item.clone(),
            seller: seller.clone(),
            state: AuctionState::Open,
            highest_bidder: None,
            highest_bid: 0,
            min_bid,
            start_block: block,
            end_block: block + duration,
            bid_count: 0,
        };

        auctions.save(&id, &auction)?;

        // Update index
        let storage = ctx.storage();
        let mut list = storage.get_str("auction_list").unwrap_or_default();
        if !list.is_empty() { list.push(','); }
        list.push_str(&id);
        storage.set_str("auction_list", &list)?;

        ctx.emit("AuctionCreated", &json!({
            "id": id,
            "item": item,
            "seller": seller,
            "min_bid": min_bid,
            "end_block": block + duration,
            "block": block
        }));

        Ok(Response::data(json!({
            "created": id,
            "end_block": block + duration
        })))
    }

    pub fn bid(ctx: Context) -> Result<Response> {
        let auction_id: String = ctx.param("auction_id")?;
        let bidder: String = ctx.param("bidder")?;
        let amount: u64 = ctx.param("amount")?;

        let auctions = ctx.storage().map::<String, Auction>("auction");

        // ── Validation chain (all checks before mutation) ──

        let mut auction: Auction = auctions
            .load(&auction_id)?
            .ok_or_else(|| ContractError::msg("auction not found"))?;

        if auction.state != AuctionState::Open {
            return Err(ContractError::msg("auction is not open"));
        }

        let block = ctx.block_height();
        if block > auction.end_block {
            // Auto-close if expired
            auction.state = AuctionState::Cancelled;
            auctions.save(&auction_id, &auction)?;
            return Err(ContractError::msg("auction has ended"));
        }

        // Determine minimum acceptable bid
        let min_required = if auction.highest_bid > 0 {
            auction.highest_bid + 1  // Must strictly exceed current highest
        } else {
            auction.min_bid
        };

        if amount < min_required {
            return Err(ContractError::msg(&format!(
                "bid must be at least {min_required}"
            )));
        }

        // ── Record the bid ──

        // Track previous bidder (for refund in production)
        let _previous_bidder = auction.highest_bidder.clone();
        let _previous_bid = auction.highest_bid;

        auction.highest_bidder = Some(bidder.clone());
        auction.highest_bid = amount;
        auction.bid_count += 1;

        auctions.save(&auction_id, &auction)?;

        ctx.emit("BidPlaced", &json!({
            "auction_id": auction_id,
            "bidder": bidder,
            "amount": amount,
            "previous_high": _previous_bid,
            "bid_count": auction.bid_count,
            "block": block
        }));

        Ok(Response::data(json!({
            "auction_id": auction_id,
            "bidder": bidder,
            "amount": amount,
            "is_highest": true
        })))
    }

    pub fn end_auction(ctx: Context) -> Result<Response> {
        let auction_id: String = ctx.param("auction_id")?;

        let auctions = ctx.storage().map::<String, Auction>("auction");

        let mut auction: Auction = auctions
            .load(&auction_id)?
            .ok_or_else(|| ContractError::msg("auction not found"))?;

        // Must still be open
        if auction.state != AuctionState::Open {
            return Err(ContractError::msg("auction already ended"));
        }

        // Deadline must have passed
        if ctx.block_height() <= auction.end_block {
            return Err(ContractError::msg("auction still active"));
        }

        // Determine outcome
        let old_state = auction.state.clone();
        let winner = auction.highest_bidder.clone();
        let winning_bid = auction.highest_bid;

        auction.state = if winner.is_some() {
            AuctionState::Sold
        } else {
            AuctionState::Cancelled
        };

        auctions.save(&auction_id, &auction)?;

        ctx.emit("AuctionEnded", &json!({
            "id": auction_id,
            "old_state": format!("{:?}", old_state),
            "new_state": format!("{:?}", auction.state),
            "winner": winner,
            "winning_bid": winning_bid,
            "bid_count": auction.bid_count,
            "block": ctx.block_height()
        }));

        Ok(Response::data(json!({
            "auction_id": auction_id,
            "state": format!("{:?}", auction.state),
            "winner": winner,
            "winning_bid": winning_bid,
            "total_bids": auction.bid_count
        })))
    }

    pub fn get_auction(ctx: Context) -> Result<Response> {
        let auction_id: String = ctx.param("auction_id")?;

        let auction: Auction = ctx.storage()
            .map::<String, Auction>("auction")
            .load(&auction_id)?
            .ok_or_else(|| ContractError::msg("auction not found"))?;

        let current_block = ctx.block_height();

        Ok(Response::data(json!({
            "id": auction.id,
            "item": auction.item,
            "seller": auction.seller,
            "state": format!("{:?}", auction.state),
            "highest_bidder": auction.highest_bidder,
            "highest_bid": auction.highest_bid,
            "min_bid": auction.min_bid,
            "start_block": auction.start_block,
            "end_block": auction.end_block,
            "bid_count": auction.bid_count,
            "current_block": current_block,
            "time_remaining": if current_block <= auction.end_block {
                auction.end_block - current_block
            } else {
                0u64
            },
            "is_open": auction.state == AuctionState::Open
        })))
    }

    pub fn list_auctions(ctx: Context) -> Result<Response> {
        let storage = ctx.storage();
        let list = storage.get_str("auction_list").unwrap_or_default();
        let auctions = storage.map::<String, Auction>("auction");

        let mut result = Vec::new();
        for id in list.split(',') {
            if id.is_empty() { continue; }
            if let Some(a) = auctions.load(&id.to_string())? {
                result.push(json!({
                    "id": a.id,
                    "item": a.item,
                    "state": format!("{:?}", a.state),
                    "highest_bid": a.highest_bid,
                    "highest_bidder": a.highest_bidder,
                    "bid_count": a.bid_count,
                    "end_block": a.end_block
                }));
            }
        }

        Ok(Response::data(json!({
            "auctions": result,
            "count": result.len()
        })))
    }
}
```

## Test cases

```python
#!/usr/bin/env python3
"""Integration test for auction exercise."""
import json, urllib.request

BASE = "http://127.0.0.1:8091"

def execute(module_id, params):
    data = json.dumps(params).encode()
    req = urllib.request.Request(
        f"{BASE}/api/v1/modules/{module_id}/execute",
        data=data, headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req).read())

# Test 1: Create auction
result = execute("auction", {
    "operation": "create_auction",
    "auction_id": "auc-1",
    "item": "Vintage Camera",
    "seller": "did:key:seller",
    "min_bid": 100,
    "duration": 50  # Short for testing
})
assert result["success"]
print("✓ Created auction auc-1")

# Test 2: Duplicate auction fails
result = execute("auction", {
    "operation": "create_auction",
    "auction_id": "auc-1",
    "item": "Duplicate",
    "seller": "did:key:seller"
})
assert not result["success"]
print("✓ Duplicate auction rejected")

# Test 3: First bid at min_bid
result = execute("auction", {
    "operation": "bid",
    "auction_id": "auc-1",
    "bidder": "did:key:bob",
    "amount": 100
})
assert result["success"]
print("✓ Bob bid 100 (minimum)")

# Test 4: Higher bid
result = execute("auction", {
    "operation": "bid",
    "auction_id": "auc-1",
    "bidder": "did:key:alice",
    "amount": 250
})
assert result["success"]
print("✓ Alice bid 250 (new highest)")

# Test 5: Bid too low
result = execute("auction", {
    "operation": "bid",
    "auction_id": "auc-1",
    "bidder": "did:key:charlie",
    "amount": 200  # Less than 251 required
})
assert not result["success"]
print("✓ Charlie's bid 200 rejected (must beat 250)")

# Test 6: Bid equal to highest fails
result = execute("auction", {
    "operation": "bid",
    "auction_id": "auc-1",
    "bidder": "did:key:charlie",
    "amount": 250  # Must strictly exceed
})
assert not result["success"]
print("✓ Equal bid rejected (must strictly exceed)")

# Test 7: Get auction details
result = execute("auction", {"operation": "get_auction", "auction_id": "auc-1"})
assert result["result"]["highest_bid"] == 250
assert result["result"]["highest_bidder"] == "did:key:alice"
assert result["result"]["bid_count"] == 2
assert result["result"]["is_open"] is True
print("✓ Auction state: Alice winning at 250")

# Test 8: Bid on non-existent auction
result = execute("auction", {
    "operation": "bid",
    "auction_id": "nope",
    "bidder": "did:key:bob",
    "amount": 100
})
assert not result["success"]
print("✓ Bid on non-existent auction rejected")

# Test 9: End auction (may need to wait for blocks)
result = execute("auction", {"operation": "end_auction", "auction_id": "auc-1"})
if result["success"]:
    assert result["result"]["state"] == "Sold"
    assert result["result"]["winner"] == "did:key:alice"
    assert result["result"]["winning_bid"] == 250
    print(f"✓ Auction ended: Sold to Alice for 250")
else:
    print(f"  (Auction still active — retry after more blocks)")

# Test 10: Create auction with no bids, then end
execute("auction", {
    "operation": "create_auction",
    "auction_id": "auc-2",
    "item": "Unsold Item",
    "seller": "did:key:seller",
    "min_bid": 500,
    "duration": 5
})
# Note: may need to advance blocks before ending
result = execute("auction", {"operation": "end_auction", "auction_id": "auc-2"})
if result["success"]:
    assert result["result"]["state"] == "Cancelled"
    assert result["result"]["winner"] is None
    print("✓ Auction with no bids: Cancelled")

# Test 11: List auctions
result = execute("auction", {"operation": "list_auctions"})
assert result["result"]["count"] >= 2
print(f"✓ Listed {result['result']['count']} auctions")

print("\nAll tests passed!")
```

!!! note "Testing with block deadlines"
    The `end_auction` operation requires `block_height > end_block`. Since blocks advance as ledger entries are submitted, you can advance the chain by submitting a few entries between creating the auction and ending it. For reliable testing, use short durations (5-10 blocks).

## Bonus challenges

After completing the basic exercise, try these enhancements:

### 1. Refund tracking

Track all bidders and their amounts so the contract can report who needs refunds:

```rust
#[derive(Serialize, Deserialize)]
struct BidHistory {
    bidder: String,
    amount: u64,
    block: u64,
    refunded: bool,
}
```

Store bid history in a map keyed by `"{auction_id}:{bidder}"` and add a `get_refunds` operation.

### 2. Reserve price

Add a hidden reserve price that the seller sets. The auction only sells if the highest bid meets the reserve:

```rust
// In Auction struct:
reserve_price: u64,
reserve_met: bool,

// In end_auction:
if auction.highest_bid >= auction.reserve_price {
    auction.state = AuctionState::Sold;
} else {
    auction.state = AuctionState::Cancelled;  // Reserve not met
}
```

### 3. Bid increments

Require minimum bid increments (e.g., each bid must exceed the current by at least 5%):

```rust
let increment = (auction.highest_bid * 5) / 100;  // 5% increment
let min_required = auction.highest_bid + increment.max(1);
```

## Key concepts learned

- **Complex state machines** — Open → Sold/Cancelled with branching logic
- **Validation chains** — Multiple sequential guards before any mutation
- **Option types** — `highest_bidder: Option<String>` for nullable fields
- **Block-height deadlines** — Time-locked operations
- **Auto-close pattern** — Expired auctions close on next bid attempt
- **Previous state tracking** — Storing old bidder for refund logic
- **Comprehensive edge cases** — No bids, equal bids, expired auctions, duplicates
- **Rich query responses** — `time_remaining`, `is_open`, computed fields

## Congratulations!

You've completed all 6 exercises! You now have hands-on experience with:

- Basic storage and events (Counter)
- Maps and arithmetic (Token)
- Authorization and roles (Access Control)
- State machines and time logic (Voting)
- Cross-contract composition (Multi-Contract)
- Complex state and edge cases (Auction)

Review the [Best Practices](../best-practices.md) and [Cheatsheet](../cheatsheet.md) to consolidate your knowledge, then study the reference contracts (`admin-registry-v2`, `voting-trust`, `ctzn-token`) for real-world patterns.
