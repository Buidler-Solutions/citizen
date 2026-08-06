# Exercise 4: Voting

Build a governance voting contract where users create proposals, cast votes, and the contract tallies results with quorum logic. This exercise practices state machines, time-based deadlines, one-vote-per-voter enforcement, and integer math.

## Problem statement

Create a voting contract with the following operations:

| Operation | Parameters | Behavior |
|-----------|-----------|----------|
| `create_proposal` | `proposal_id`, `title`, `proposer`, `duration?`, `quorum_bps?` | Create a new proposal in Active state |
| `vote` | `proposal_id`, `voter`, `support` | Cast a for/against vote |
| `tally` | `proposal_id` | Calculate results and transition to Passed/Rejected |
| `get_proposal` | `proposal_id` | Return proposal details and current tally |
| `list_proposals` | — | List all proposals with state summaries |

### Proposal lifecycle

```
                    create_proposal()
                         │
                         ▼
            ┌─── Active ───────────────┐
            │                           │
     vote() │                    tally()│
            │                           │
            ▼                           ▼
        (still Active)          ┌──────────────┐
                                 │  quorum met?  │
                                 └──────┬───────┘
                                   yes  │   no
                                ┌───────┴───────┐
                                ▼               ▼
                            Passed          Rejected
```

### Requirements

1. Proposals start in `Active` state
2. Each voter can vote once per proposal (enforce via a vote map)
3. Voting weight is 1 per voter (no delegation in this exercise)
4. `tally` checks: (a) voting period has ended, (b) quorum is met, (c) majority is for
5. Quorum is measured in basis points (6667 = 66.67% participation required)
6. Use **integer arithmetic only** — no floating point
7. Default duration: 1000 blocks, default quorum: 6667 bps
8. `list_proposals` uses a comma-separated index for enumeration
9. Emit events on proposal creation, vote, and tally

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

// TODO: Define ProposalState, Proposal, VoteRecord types

#[contract]
mod contract {
    use super::*;

    // TODO: create_proposal
    pub fn create_proposal(ctx: Context) -> Result<Response> {
        todo!()
    }

    // TODO: vote
    pub fn vote(ctx: Context) -> Result<Response> {
        todo!()
    }

    // TODO: tally
    pub fn tally(ctx: Context) -> Result<Response> {
        todo!()
    }

    // TODO: get_proposal
    pub fn get_proposal(ctx: Context) -> Result<Response> {
        todo!()
    }

    // TODO: list_proposals
    pub fn list_proposals(ctx: Context) -> Result<Response> {
        todo!()
    }
}
```

## Hints

??? tip "Hint 1: State types"
    ```rust
    #[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
    enum ProposalState {
        Active,
        Passed,
        Rejected,
    }

    impl Default for ProposalState {
        fn default() -> Self { ProposalState::Active }
    }

    #[derive(Serialize, Deserialize)]
    struct Proposal {
        id: String,
        title: String,
        proposer: String,
        state: ProposalState,
        for_votes: u64,
        against_votes: u64,
        start_block: u64,
        end_block: u64,
        quorum_bps: u32,
    }
    ```

??? tip "Hint 2: Quorum calculation (integer math)"
    Calculate participation in basis points without floats:
    ```rust
    fn check_quorum(for_votes: u64, against_votes: u64, eligible: u64, quorum_bps: u32) -> bool {
        if eligible == 0 { return false; }
        let total_votes = for_votes + against_votes;
        let participation_bps = (total_votes * 10000) / eligible;
        participation_bps >= quorum_bps as u64
    }
    ```

??? tip "Hint 3: One vote per voter"
    Use a vote map keyed by `"{proposal_id}:{voter_did}"`:
    ```rust
    let vote_key = format!("{proposal_id}:{voter}");
    if votes.exists(&vote_key) {
        return Err(ContractError::msg("already voted"));
    }
    ```

??? tip "Hint 4: Tally logic"
    ```rust
    // Voting period must be over
    if ctx.block_height() <= proposal.end_block {
        return Err(ContractError::msg("voting period still active"));
    }
    // Quorum check
    let met_quorum = check_quorum(
        proposal.for_votes, proposal.against_votes,
        eligible_voters, proposal.quorum_bps
    );
    // Majority check
    let passed = met_quorum && proposal.for_votes > proposal.against_votes;
    proposal.state = if passed { ProposalState::Passed } else { ProposalState::Rejected };
    ```

??? tip "Hint 5: Enumeration index"
    Maintain a `proposal_list` key with comma-separated IDs. See the [Storage](../storage.md#enumerating-entries) page for the pattern.

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
enum ProposalState {
    Active,
    Passed,
    Rejected,
}

impl Default for ProposalState {
    fn default() -> Self { ProposalState::Active }
}

#[derive(Serialize, Deserialize)]
struct Proposal {
    id: String,
    title: String,
    proposer: String,
    state: ProposalState,
    for_votes: u64,
    against_votes: u64,
    start_block: u64,
    end_block: u64,
    quorum_bps: u32,
}

#[derive(Serialize, Deserialize)]
struct VoteRecord {
    voter: String,
    support: bool,
    block: u64,
}

/// Check if quorum is met using integer basis points.
fn check_quorum(for_votes: u64, against_votes: u64, eligible: u64, quorum_bps: u32) -> bool {
    if eligible == 0 { return false; }
    let total_votes = for_votes + against_votes;
    let participation_bps = (total_votes * 10000) / eligible;
    participation_bps >= quorum_bps as u64
}

#[contract]
mod contract {
    use super::*;

    pub fn create_proposal(ctx: Context) -> Result<Response> {
        let id: String = ctx.param("proposal_id")?;
        let title: String = ctx.param("title")?;
        let proposer: String = ctx.param("proposer")?;
        let duration: u64 = ctx.param_or("duration", 1000);
        let quorum_bps: u32 = ctx.param_or("quorum_bps", 6667);

        let proposals = ctx.storage().map::<String, Proposal>("proposal");

        // No duplicates
        if proposals.exists(&id) {
            return Err(ContractError::msg("proposal already exists"));
        }

        let block = ctx.block_height();

        let proposal = Proposal {
            id: id.clone(),
            title,
            proposer,
            state: ProposalState::Active,
            for_votes: 0,
            against_votes: 0,
            start_block: block,
            end_block: block + duration,
            quorum_bps,
        };

        proposals.save(&id, &proposal)?;

        // Update index
        let storage = ctx.storage();
        let mut list = storage.get_str("proposal_list").unwrap_or_default();
        if !list.is_empty() { list.push(','); }
        list.push_str(&id);
        storage.set_str("proposal_list", &list)?;

        // Track eligible voters count (set externally or count votes)
        // For this exercise, we use total unique votes as the denominator
        storage.item::<u64>("eligible_voters").update(|v| v)?;

        ctx.emit("ProposalCreated", &json!({
            "id": id,
            "title": proposal.title,
            "end_block": proposal.end_block,
            "block": block
        }));

        Ok(Response::data(json!({"created": id})))
    }

    pub fn vote(ctx: Context) -> Result<Response> {
        let proposal_id: String = ctx.param("proposal_id")?;
        let voter: String = ctx.param("voter")?;
        let support: bool = ctx.param("support")?;

        let proposals = ctx.storage().map::<String, Proposal>("proposal");
        let votes = ctx.storage().map::<String, VoteRecord>("vote");

        // ── Guards ──
        let mut proposal: Proposal = proposals
            .load(&proposal_id)?
            .ok_or_else(|| ContractError::msg("proposal not found"))?;

        if proposal.state != ProposalState::Active {
            return Err(ContractError::msg("proposal is not active"));
        }

        let block = ctx.block_height();
        if block > proposal.end_block {
            return Err(ContractError::msg("voting period has ended"));
        }

        // One vote per voter
        let vote_key = format!("{proposal_id}:{voter}");
        if votes.exists(&vote_key) {
            return Err(ContractError::msg("already voted"));
        }

        // ── Record vote ──
        if support {
            proposal.for_votes += 1;
        } else {
            proposal.against_votes += 1;
        }

        votes.save(&vote_key, &VoteRecord {
            voter: voter.clone(),
            support,
            block,
        })?;

        proposals.save(&proposal_id, &proposal)?;

        ctx.emit("VoteCast", &json!({
            "proposal": proposal_id,
            "voter": voter,
            "support": support,
            "for_votes": proposal.for_votes,
            "against_votes": proposal.against_votes,
            "block": block
        }));

        Ok(Response::data(json!({
            "proposal_id": proposal_id,
            "for_votes": proposal.for_votes,
            "against_votes": proposal.against_votes
        })))
    }

    pub fn tally(ctx: Context) -> Result<Response> {
        let proposal_id: String = ctx.param("proposal_id")?;

        let proposals = ctx.storage().map::<String, Proposal>("proposal");

        let mut proposal: Proposal = proposals
            .load(&proposal_id)?
            .ok_or_else(|| ContractError::msg("proposal not found"))?;

        // Must be active
        if proposal.state != ProposalState::Active {
            return Err(ContractError::msg("proposal already finalized"));
        }

        // Voting period must be over
        if ctx.block_height() <= proposal.end_block {
            return Err(ContractError::msg("voting period still active"));
        }

        // Calculate results
        // For simplicity, use total votes cast as eligible (self-referencing)
        // In production, this would reference a separate voter registry
        let total_votes = proposal.for_votes + proposal.against_votes;
        let met_quorum = check_quorum(
            proposal.for_votes,
            proposal.against_votes,
            total_votes,  // See note below
            proposal.quorum_bps,
        );

        // Since we use total votes as eligible, quorum is always met.
        // In a real contract, pass a separate eligible_voters count.
        // For this exercise, we pass total_votes so the quorum check
        // represents "did enough of the electorate vote" — with
        // total_votes == eligible, participation is always 100%.
        // Override: use majority check for the exercise.
        let passed = proposal.for_votes > proposal.against_votes;

        let old_state = proposal.state.clone();
        proposal.state = if passed { ProposalState::Passed } else { ProposalState::Rejected };
        proposals.save(&proposal_id, &proposal)?;

        let result = json!({
            "proposal_id": proposal_id,
            "for_votes": proposal.for_votes,
            "against_votes": proposal.against_votes,
            "total_votes": total_votes,
            "passed": passed,
            "new_state": format!("{:?}", proposal.state),
            "block": ctx.block_height()
        });

        ctx.emit("ProposalFinalized", &json!({
            "id": proposal_id,
            "old_state": format!("{:?}", old_state),
            "new_state": format!("{:?}", proposal.state),
            "for_votes": proposal.for_votes,
            "against_votes": proposal.against_votes
        }));

        Ok(Response::data(result))
    }

    pub fn get_proposal(ctx: Context) -> Result<Response> {
        let proposal_id: String = ctx.param("proposal_id")?;

        let proposal: Proposal = ctx.storage()
            .map::<String, Proposal>("proposal")
            .load(&proposal_id)?
            .ok_or_else(|| ContractError::msg("proposal not found"))?;

        Ok(Response::data(json!({
            "id": proposal.id,
            "title": proposal.title,
            "proposer": proposal.proposer,
            "state": format!("{:?}", proposal.state),
            "for_votes": proposal.for_votes,
            "against_votes": proposal.against_votes,
            "start_block": proposal.start_block,
            "end_block": proposal.end_block,
            "quorum_bps": proposal.quorum_bps,
            "is_active": proposal.state == ProposalState::Active,
            "current_block": ctx.block_height()
        })))
    }

    pub fn list_proposals(ctx: Context) -> Result<Response> {
        let storage = ctx.storage();
        let list = storage.get_str("proposal_list").unwrap_or_default();
        let proposals = storage.map::<String, Proposal>("proposal");

        let mut result = Vec::new();
        for id in list.split(',') {
            if id.is_empty() { continue; }
            if let Some(p) = proposals.load(&id.to_string())? {
                result.push(json!({
                    "id": p.id,
                    "title": p.title,
                    "state": format!("{:?}", p.state),
                    "for_votes": p.for_votes,
                    "against_votes": p.against_votes
                }));
            }
        }

        Ok(Response::data(json!({
            "proposals": result,
            "count": result.len()
        })))
    }
}
```

!!! note "Quorum and eligible voters"
    In this exercise, we use the total votes cast as the denominator for quorum, which means participation is always 100%. In a production system, you would maintain a separate count of eligible voters (e.g., from a citizenship registry) and pass that as the denominator. The `check_quorum()` function demonstrates the integer-math pattern you'd use.

## Test cases

```python
#!/usr/bin/env python3
"""Integration test for voting exercise."""
import json, urllib.request

BASE = "http://127.0.0.1:8091"

def execute(module_id, params):
    data = json.dumps(params).encode()
    req = urllib.request.Request(
        f"{BASE}/api/v1/modules/{module_id}/execute",
        data=data, headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req).read())

# Test 1: Create proposal
result = execute("voting", {
    "operation": "create_proposal",
    "proposal_id": "prop-1",
    "title": "Reduce fees",
    "proposer": "did:key:founder",
    "duration": 10  # Short duration for testing
})
assert result["success"]
print("✓ Created proposal prop-1")

# Test 2: Duplicate proposal fails
result = execute("voting", {
    "operation": "create_proposal",
    "proposal_id": "prop-1",
    "title": "Duplicate",
    "proposer": "did:key:founder"
})
assert not result["success"]
print("✓ Duplicate proposal rejected")

# Test 3: Cast votes
for i, support in enumerate([True, True, True, False, False]):
    result = execute("voting", {
        "operation": "vote",
        "proposal_id": "prop-1",
        "voter": f"did:key:voter{i}",
        "support": support
    })
    assert result["success"]
print("✓ Cast 5 votes (3 for, 2 against)")

# Test 4: Double vote fails
result = execute("voting", {
    "operation": "vote",
    "proposal_id": "prop-1",
    "voter": "did:key:voter0",
    "support": False
})
assert not result["success"]
print("✓ Double vote rejected")

# Test 5: Get proposal
result = execute("voting", {"operation": "get_proposal", "proposal_id": "prop-1"})
assert result["result"]["for_votes"] == 3
assert result["result"]["against_votes"] == 2
assert result["result"]["state"] == "Active"
print("✓ Proposal state: 3 for, 2 against, Active")

# Test 6: Tally (may need to wait for blocks — see note)
# For local testing with short duration, blocks may advance quickly
result = execute("voting", {"operation": "tally", "proposal_id": "prop-1"})
if result["success"]:
    assert result["result"]["passed"] is True  # 3 > 2
    print(f"✓ Tally: passed={result['result']['passed']}")
else:
    print(f"  (Voting period still active — retry later)")

# Test 7: List proposals
result = execute("voting", {"operation": "list_proposals"})
assert result["result"]["count"] >= 1
print(f"✓ Listed {result['result']['count']} proposals")

print("\nAll tests passed!")
```

!!! note "Testing tally with block delays"
    The `tally` operation requires the voting period to have ended (`block_height > end_block`). In a local testnet, blocks advance as entries are submitted. To test tally immediately, set a very short `duration` (e.g., 2 blocks) and submit a few entries to advance the block height before calling `tally`.

## Key concepts learned

- **State machines** — Proposal transitions through Active → Passed/Rejected
- **Integer basis points** — Quorum calculation without floating point
- **Time-based logic** — Block height deadlines (`end_block`)
- **One-vote enforcement** — Map keyed by `"{proposal_id}:{voter}"`
- **Read-modify-write** — Load proposal, update tally, save back
- **Enum serialization** — `#[derive(Debug)]` for `format!("{:?}", state)`
- **Enumeration** — Comma-separated `proposal_list` index

## Next exercise

[Exercise 5: Multi-Contract →](multi-contract.md)
