# Consensus

Citizen uses **linear BFT (Byzantine Fault Tolerance)** consensus with deterministic finality.

## Key Properties

| Property | Value |
|----------|-------|
| Consensus type | Linear BFT |
| Quorum threshold | >2/3 supermajority (80%) |
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

The localnet configuration uses 5 validators, tolerating 1 faulty node with an 80% quorum threshold.

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
