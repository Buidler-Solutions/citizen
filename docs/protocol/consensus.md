# Consensus

Citizen uses **linear BFT (Byzantine Fault Tolerance)** consensus with deterministic finality.

## Key Properties

| Property | Value |
|----------|-------|
| Consensus type | Linear BFT |
| Quorum threshold | >2/3 supermajority (6667 bps) |
| Finality | Deterministic (~1 second) |
| Fault tolerance | Up to f faulty validators in a network of 3f+1 |
| Leader rotation | Round-robin with view-change on failure |

## How It Works

### Block Proposal

The current leader proposes a block containing validated entries. The leader is determined by a deterministic round-robin schedule based on the current view number.

### Voting

Each validator independently verifies the proposed block:

1. **Entry validation** — all entries pass namespace policy checks
2. **Signature verification** — all signatures are valid
3. **Sequence integrity** — entry sequence numbers are correct
4. **Policy compliance** — consensus rules are satisfied

Validators then cast their vote by signing the block hash.

### Commitment

When >2/3 of validators have signed the same block hash, the block is committed. Finality is **deterministic** — once committed, a block cannot be reverted. There is no probabilistic confirmation.

### View Change

If the leader fails to propose within the timeout, validators trigger a view change. The next validator in the round-robin schedule becomes the leader. View changes do not affect already-committed blocks.

## Fault Tolerance

In a network of `N` validators, Citizen tolerates up to `f` Byzantine (malicious) validators where:

```
N ≥ 3f + 1
```

| Validators | Max Faulty | Quorum Needed |
|------------|-----------|---------------|
| 4 | 1 | 3 (75%) |
| 5 | 1 | 4 (80%) |
| 7 | 2 | 5 (71%) |
| 10 | 3 | 7 (70%) |

Quorum is configured at 6667 basis points (>2/3). The resulting vote count
is `ceiling(N × 6667/10000)`. With 5 validators this yields 4 votes — which
*looks* like 80% but is simply ceiling rounding at small N, not a separate
80% policy.

The localnet configuration uses 5 validators, tolerating 1 faulty node at the
>2/3 BFT quorum threshold (6667 bps).

## Simulation

The protocol includes a simulation harness that tests:

- Normal multi-validator operation
- Partial validator failure
- Complete quorum loss and recovery
- Malicious leader behavior
- Byzantine validator subsets
- Network partitions

Run simulations:

```bash
cd citizen-protocol
cargo test -p citizen-simulation
```

## Block Sync

New validators joining mid-chain must catch up to the current block height before participating in consensus. Citizen implements an **automatic block sync protocol** that reuses the existing QUIC transport and `ConsensusMessage` infrastructure — no manual sync command is needed.

### How It Works

1. **Startup sync** — Before entering the consensus event loop, a node calls `sync_from_peers()` which unicast `SyncRequest` messages to all configured peers requesting missing blocks.

2. **Heartbeat-driven detection** — During normal operation, when a node receives a heartbeat from a peer reporting a higher block height, it automatically requests the missing blocks. This is zero-configuration: gaps are detected and filled without operator intervention.

3. **Batched responses** — Each `SyncResponse` contains at most 50 blocks to stay within QUIC message size limits. Multiple round-trips are handled naturally by the heartbeat mechanism re-triggering sync.

4. **Contiguity enforcement** — The syncer only applies blocks at `latest_height + 1`. Non-contiguous blocks are skipped, preventing chain divergence.

### Trust Model

Synced blocks go through the normal `finalize_block` → `apply_block` → `validate_block` → `verify_commit_proof` path:

- Sync blocks must carry valid BFT commit proofs (>2/3 validator signatures)
- A malicious peer **cannot inject fake blocks** — they need valid cryptographic signatures from the known validator set
- Each block's commit proof is verified independently against the validator key registry

### Message Types

Two new consensus message types piggyback on the existing QUIC transport:

| Message | Fields | Purpose |
|---------|--------|---------|
| `SyncRequest` | `requester: ValidatorId`, `from_height: u64`, `to_height: u64` | Request a range of blocks from a peer |
| `SyncResponse` | `requester: ValidatorId`, `blocks: Vec<Block>` | Return up to 50 blocks per response |

### Joining Mid-Chain

A remote validator can join an existing chain simply by starting with correct peer configuration:

1. The node starts, loads its key material and namespace config
2. The startup sync phase (`sync_from_peers`) requests blocks from all peers
3. Blocks are applied contiguously with full commit-proof verification
4. Once caught up, the node enters the normal consensus event loop
5. Heartbeat-driven detection fills any remaining gaps during operation
