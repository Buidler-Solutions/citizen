# Citizen Consensus Engine — Architecture & Operations Guide

> **Status**: Implementation-accurate. Last updated: 2026-08-02.
> **Quorum**: BFT >2/3 (6667 bps). Former 80% (8000 bps) retired.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Quorum Model](#2-quorum-model)
3. [Transaction Lifecycle](#3-transaction-lifecycle)
4. [Consensus Algorithm](#4-consensus-algorithm)
5. [Entry Gossip](#5-entry-gossip)
6. [Event Loop Design](#6-event-loop-design)
7. [Network Layer](#7-network-layer)
8. [Node Configuration](#8-node-configuration)
9. [Block Finalization](#9-block-finalization)
10. [Troubleshooting](#10-troubleshooting)
11. [Exercises](#11-exercises)

---

## 1. Architecture Overview

```text
┌─────────────────────────────────────────────────────────────────┐
│                        CITIZEN LOCALNET                          │
│                                                                 │
│  Validator Alpha (8081) ◄──── QUIC ────► Validator Beta (8082) │
│  Validator Gamma (8083) ◄──── QUIC ────► Validator Delta (8084)│
│  Validator Epsilon (8085)                                       │
│                                                                 │
│  Each validator runs:                                           │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ API Server (Axum)  │  Consensus Engine  │  RocksDB Store │   │
│  │ Port 8081-8085     │  Watchdog-driven   │  Per-node CFs  │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### Key Components

| Component | Crate | Role |
|-----------|-------|------|
| ConsensusEngine | `citizen-consensus` | Leader election, block proposal, PreVote/Commit rounds |
| QuicNetwork | `citizen-network` | QUIC transport, peer connections, message broadcast |
| Ledger | `citizen-ledger` | Namespace validation, entry storage, block application |
| RocksDbStorage | `citizen-storage` | Persistent KV store with column families |
| ApiServer | `citizen-api` | HTTP API, envelope submissions, blocks/entries queries |

---

## 2. Quorum Model

### BFT >2/3 (6667 bps)

Quorum is defined as `ceil(quorum_bps / 10000 * num_active_validators)`.

| Active Validators | Quorum Threshold | Fault Tolerance |
|---|---|---|
| 3 | 3 (100%) | 0 Byzantine |
| 4 | 3 (75%) | 1 Byzantine |
| **5** | **4 (80%)** | **1 Byzantine** |
| 7 | 5 (~71%) | 2 Byzantine |
| 10 | 7 (70%) | 3 Byzantine |

### Why >2/3 Instead of 80%

Standard BFT quorum is `>2/3` of active validators. At `>2/3`, with `n` validators:
- Quorum = `ceil(n * 2/3) + 1 = floor(2n/3) + 1`
- Fault tolerance = `floor((n-1)/3)` Byzantine nodes

The former 80% (8000 bps) was too conservative — it required 4/5 for a 5-node network (same as >2/3) but broke with 6+ validators (requiring 5, which is >2/3 + 1).

### Configuration

```toml
# citizen-protocol/config/localnet/validator-alpha.toml
quorum_bps = 6667
block_time_millis = 1000
```

---

## 3. Transaction Lifecycle

Every transaction goes through three phases:

```text
┌─────────────────┐     ┌──────────────────────┐     ┌──────────────────────────┐
│ PHASE 1         │     │ PHASE 2              │     │ PHASE 3                  │
│ SUBMIT          │ ──► │ GOSSIP               │ ──► │ BLOCK FINALIZATION       │
│                 │     │                      │     │                          │
│ Entry stored on │     │ NewEntry broadcast   │     │ Leader collects entries  │
│ receiving node  │     │ to all peers (≤2s)   │     │ → Proposal → PreVote →  │
│ (local RocksDB) │     │ Peers call           │     │ Commit → Block stored   │
│                 │     │ apply_entry()        │     │ on ALL nodes            │
└─────────────────┘     └──────────────────────┘     └──────────────────────────┘
```

### Phase 1 — Submission

```http
POST /api/v1/envelopes/submit
Content-Type: application/json

{
  "envelope_id": "uuid",
  "signer": "registry.identity",
  "signature": "hex-ed25519-sig",
  "submitted_at": "2026-08-02T00:00:00Z",
  "payload": {
    "entry_id": "uuid",
    "namespace": "identity.citizen",
    "action": "REGISTER_IDENTITY",
    "object_id": "did:citizen:user-abc",
    "payload": { "author_public_key": "hex-vk" },
    "author": "registry.identity",
    "signature": "hex-ed25519-sig",
    "timestamp": 1785680000,
    "privacy_flag": false,
    "privacy_mode": "none"
  }
}
```

**Validation performed**:
- `validate_envelope_signatures`: signer == author, signature copied to entry
- `validate_entry_submission`: namespace rules + Ed25519 signature verification (canonical JSON)
- `validate_entry`: namespace must exist, author in writers, all validators pass
- `apply_entry`: store in RocksDB with key `namespace\x1fentry_id`

**Result**: `{ "status": "accepted", "entry_id": "uuid", "block_height": N }`

### Phase 2 — Gossip (≤2 seconds)

The `gossip_pending_entries()` background task runs every 2 seconds:

```rust
// crates/consensus/src/lib.rs
tokio::spawn(async move {
    let mut gossip_ticker = interval(Duration::from_millis(2000));
    loop {
        gossip_ticker.tick().await;
        gossip_engine.gossip_pending_entries().await;
    }
});
```

For each entry in the local pool not yet gossiped:
1. Broadcast `ConsensusMessage::NewEntry(entry)` to all peers
2. Broadcasts are spawned as `tokio::spawn` (non-blocking)
3. Receiving nodes call `apply_entry()` to store locally

**Design rationale**: Without gossip, entries submitted to node A are invisible to node B. Since the leader rotates every block, an entry must be on the leader's local storage to be included in a proposal. Gossip bridges this gap.

### Phase 3 — Block Finalization

1. **Collect entries**: Leader calls `collect_entries()` which scans known namespaces in local RocksDB
2. **Build proposal**: Creates `BlockProposal { header, entries }` with Merkle entry root
3. **Broadcast**: Proposal sent to all peers via QUIC (spawned, non-blocking)
4. **PreVote**: Each validator validates the proposal and broadcasts a PreVote
5. **Quorum check**: When `has_quorum(height)` → create `Commit` with aggregated signature
6. **Finalize**: `finalize_block()` → `apply_block()` → store block on all nodes

```
Leader                 Peer A                 Peer B                 Peer C
  |                      |                      |                      |
  |--- Propose(H, E) --> |--- Propose(H, E) --> |--- Propose(H, E) --> |
  |--- PreVote(H, HASH)  |--- PreVote(H, HASH)  |--- PreVote(H, HASH)  |
  |                      |                      |                      |
  |  [quorum reached: 4/5 prevotes]                                    |
  |                      |                      |                      |
  |--- Commit(H, BLOCK)  |--- Commit(H, BLOCK)  |--- Commit(H, BLOCK)  |
  |                      |                      |                      |
  |  finalize_block(H)   |  finalize_block(H)   |  finalize_block(H)   |
```

---

## 4. Consensus Algorithm

### Leader Selection

```rust
fn select_leader(&self, height: u64, snapshot: &ValidatorSetSnapshot) -> ValidatorId {
    let mut ids = self.active_validator_ids(snapshot);
    ids.sort();
    let index = (height as usize) % ids.len();
    ids[index].clone()
}
```

Leader rotates every block: `height % num_validators`. With 5 validators sorted alphabetically:
- Height 0, 5, 10, 15... → alpha
- Height 1, 6, 11, 16... → beta
- Height 2, 7, 12, 17... → delta
- Height 3, 8, 13, 18... → epsilon
- Height 4, 9, 14, 19... → gamma

### Validation Rules

| Check | Function | Description |
|-------|----------|-------------|
| Active proposer | `validate_proposal` | Proposer must be in `ValidatorStatus::Active` |
| Correct leader | `validate_proposal` | Proposer must match `select_leader(height)` |
| Chain extension | `validate_proposal` | `proposal.height == latest_height + 1` |
| PrevHash match | `validate_proposal` | Proposal's `prev_hash` must match local block at `latest_height` |
| Entry root | `validate_proposal` | `compute_entry_root(entries)` must match header |
| Namespace rules | `validate_entry` | Authors, validators, privacy flags per namespace |
| Signature | `validate_entry_submission` | Ed25519 signature over canonical JSON |

### Proposal Buffering

Proposals arriving before the receiver has finalized the previous block are **buffered**, not rejected:

```rust
if prop_height > latest_height + 1 {
    info!("buffering proposal for future height");
    self.pending_proposals.write().insert(prop_height, proposal);
    return Ok(());
}
```

After each block finalization, `try_pending_proposal()` drains buffered proposals for the next height.

### Rounds Cleanup

After finalization, old rounds are pruned:
```rust
self.rounds.write().retain(|&h, _| h >= height);
self.pending_proposals.write().retain(|&h, _| h > height);
```

---

## 5. Entry Gossip

### Message Type

```rust
pub enum ConsensusMessage {
    Propose(BlockProposal),
    Heartbeat { validator, observed_height },
    PreVote { height, validator, hash, signature },
    Commit { height, block },
    NewEntry(LedgerEntry),           // Entry gossip
    GovernanceProposal(GovernanceProposal),
    GovernanceVote(GovernanceVote),
}
```

### Gossip Flow

```text
Node A (received entry)                Node B (peer)
  │                                      │
  │ gossip_pending_entries() fires       │
  │ (every 2 seconds)                    │
  │                                      │
  │── NewEntry(entry) ──────────────────►│
  │   bytes: ~1KB (small)                │
  │   or ~1.5MB (with ciphertext_hex)    │
  │                                      │
  │                                      │ handle_message(NewEntry)
  │                                      │   → gossiped_entries.insert(id)
  │                                      │   → apply_entry(entry)
  │                                      │   → store in RocksDB
```

### Known Namespaces (gossip + collect)

```rust
let known_namespaces = [
    "identity.citizen",
    "registry.land",
    "audit.procurement",
    "governance.vote",
    "forms.commitment",
    "onboarding.interest",
    "content.article",
    "builder.credits",
    "consent.receipt",
];
```

---

## 6. Event Loop Design

### Architecture (watchdog-driven)

The consensus event loop uses an **OS-level watchdog thread** instead of Tokio timers:

```rust
// OS-level watchdog — immune to Tokio timer stalls
let (watchdog_tx, mut watchdog_rx) = mpsc::unbounded_channel();
std::thread::spawn(move || {
    loop {
        std::thread::sleep(std::time::Duration::from_millis(block_ms));
        let _ = watchdog_tx.send(());
    }
});
```

### Event Loop

```rust
loop {
    tokio::select! {
        _ = watchdog_rx.recv() => {
            // OS-thread timer, always fires
            let _ = tokio::time::timeout(Duration::from_secs(5), self.try_propose()).await;
            self.try_pending_proposal().await;
        }
        maybe_msg = inbox.recv() => {
            // Process incoming consensus messages
            if let Some(message) = maybe_msg {
                match tokio::time::timeout(Duration::from_secs(5), self.handle_message(message)).await {
                    Ok(Ok(())) => {}
                    Ok(Err(err)) => warn!(?err, "handle_message error"),
                    Err(_) => warn!("handle_message TIMED OUT"),
                }
                self.try_pending_proposal().await;
            } else {
                break; // Channel closed
            }
        }
    }
}
```

### Background Tasks

| Task | Interval | Role |
|------|----------|------|
| **Gossip** | 2 seconds | Broadcasts new entries to peers (spawned, non-blocking) |
| **Heartbeat** | Configurable | Broadcasts validator liveness |
| **Watchdog** | 1 second (block_time) | OS-thread timer for block proposal |

### Why Watchdog Instead of `interval`?

The `tokio::time::interval` depends on Tokio's internal timer driver. When QUIC `join_all` occupies worker threads, the timer can starve — causing **permanent deadlock** where no more blocks are produced.

The watchdog uses `std::thread::sleep` which is an OS-level primitive that cannot be starved by Tokio scheduler contention. Even if all Tokio worker threads are busy, the OS thread wakes up and sends a message to the event loop.

---

## 7. Network Layer

### Transport

- **Protocol**: QUIC (via Quinn 0.11)
- **Wire format**: JSON (`serde_json`) — NOT bincode (bincode cannot serialize `serde_json::Value`)
- **Flow control**: 2MB stream / 8MB connection receive windows
- **Message size limit**: 16MB (`recv.read_to_end(16 * 1024 * 1024)`)
- **Write timeout**: 5 seconds per unicast

### Message Serialization

```rust
// SEND: serialize to JSON
let data = serde_json::to_vec(&wire)
    .map_err(ProtocolError::storage)?;
send.write_all(&data).await?;
send.finish()?;

// RECV: deserialize from JSON
let data = recv.read_to_end(16 * 1024 * 1024).await?;
let wire = serde_json::from_slice::<WireMessage>(&data)?;
```

### Admission Control

Each message includes a `PeerHandshake` with validator identity, network ID, genesis hash, manifest digest, and optional PSK proof. Inbound messages are checked against the admission snapshot before being forwarded to consensus.

---

## 8. Node Configuration

### Localnet Validator (example)

```toml
# config/localnet/validator-alpha.toml
validator_id = "validator-alpha"
bind_addr = "127.0.0.1:9100"
api_port = 8081
block_time_millis = 1000
quorum_bps = 6667
heartbeat_interval_millis = 5000
epoch_length_blocks = 100
node_role = "Validator"

[[peers]]
validator_id = "validator-beta"
address = "127.0.0.1:9101"
# ... gamma:9102, delta:9103, epsilon:9104

[[namespaces]]
descriptor.namespace = "identity.citizen"
descriptor.version = 1
writers = ["registry.identity"]
[[namespaces.validators]]
name = "require_signature"
config = {}
```

### API Size Limits

| Limit | Value | Enforced At |
|-------|-------|-------------|
| Envelope JSON size | 5 MB | `process_envelope_submission` |
| QUIC stream read | 16 MB | `spawn_reader` |
| QUIC write timeout | 5 sec | `unicast` |

---

## 9. Block Finalization

### Block Structure

```rust
pub struct Block {
    pub header: BlockHeader,
    pub entries: Vec<LedgerEntry>,
}

pub struct BlockHeader {
    pub height: u64,
    pub prev_hash: String,
    pub entry_root: String,         // blake3 Merkle root of entries
    pub proposer: ValidatorId,
    pub timestamp: i64,
    pub commit_proof: CommitProof,
}
```

### Finalization Steps

```rust
async fn finalize_block(&self, height: u64, block: Block) -> Result<()> {
    // 1. Mark entries as included (dedup)
    for entry in &block.entries {
        self.included_entries.write().insert(entry.entry_id);
    }

    // 2. Apply block to ledger (validate + store)
    self.ledger.apply_block(block.clone())?;

    // 3. Record liveness (prevote participation)
    self.record_liveness(height, &block);

    // 4. Clean up old rounds
    self.rounds.write().retain(|&h, _| h >= height);
    self.pending_proposals.write().retain(|&h, _| h > height);

    // 5. Log
    info!(height, entry_count = block.entries.len(), ?entry_ids, "block finalized");
}
```

### After Finalization

The `try_pending_proposal()` method is called from the event loop after every tick and message handling. It checks for buffered proposals for `latest_height + 1` and processes them.

---

## 10. Troubleshooting

### Symptom: Block `entry_count=0` despite successful submission

**Check**:
```bash
# Is the entry stored on alpha?
grep "entry stored" data/validator-alpha.log | tail -5

# Is gossip working?
grep "received gossiped" data/validator-*.log | tail -5

# Is the entry being collected?
grep "collect_entries count=[1-9]" data/validator-alpha.log | tail -5

# Any deserialization errors?
grep "deserialize\|failed" data/validator-*.log | tail -5
```

### Symptom: Consensus deadlock (no blocks for >5 seconds)

**Check**:
```bash
# Last block on each node
for f in data/validator-*.log; do
  sed 's/\x1b\[[0-9;]*m//g' "$f" | grep "block finalized" | tail -1
done

# Any timeout warnings?
grep "TIMED OUT\|inbox closed" data/validator-alpha.log | tail -5

# Proposal rejections
grep "rejecting invalid proposal" data/validator-alpha.log | tail -5
```

### Symptom: "No blocks matched your search" for valid entry_id

**Fix**: The explorer's `/blocks?q=<entry_id>` now redirects to the correct block page via backend lookup. If it still fails:
```bash
# Check the backend lookup works
python3 -c "
from urllib.request import urlopen
import json
r = urlopen('http://localhost:4444/entries/lookup/<entry_id>', timeout=60)
print(json.loads(r.read()))
"

# If null, the entry might be in a block beyond the 10,000-block scan limit
# Submit a new entry and verify with:
grep "entry_count=[1-9]" data/validator-alpha.log | tail -3
```

### Symptom: Entry rejected with "envelope_too_large"

The envelope exceeds the 5MB API limit. This typically happens when `ciphertext_hex` contains a large encrypted document attachment. The encrypted file should be stored off-chain (MinIO) — only the hash should appear on-chain.

---

## 11. Exercises

### Exercise 1: Trace a Transaction (Beginner)

1. Start localnet: `cd citizen-protocol && scripts/run_localnet.sh`
2. Wait for blocks to start producing (`grep "block finalized" data/validator-alpha.log`)
3. Submit a test entry:
   ```bash
   python3 scripts/submit_test_entry.py
   ```
4. Find the entry in the logs:
   ```bash
   grep "entry stored\|gossiping\|block finalized.*entry_count=[1-9]" data/validator-alpha.log | tail -5
   ```
5. **Questions**:
   - What block number contains your entry?
   - Which validator proposed that block?
   - Verify the same entry appears on all 5 nodes.

### Exercise 2: Simulate a Proposal Race Condition (Intermediate)

1. Modify `config/localnet/validator-alpha.toml`: set `block_time_millis = 5000` (slower)
2. Modify other validators: set `block_time_millis = 1000` (normal)
3. Start localnet and submit an entry from a fast validator
4. Observe the logs for `"buffering proposal for future height"`
5. Verify that the buffered proposal gets processed after the slow validator catches up
6. **Questions**:
   - How many blocks are produced before the buffered proposal is processed?
   - What would happen without proposal buffering? (Revert the `pending_proposals` code and retry)

### Exercise 3: Break and Fix Consensus (Advanced)

1. **Break it**: Reduce `quorum_bps` to 5000 in all configs (only 3/5 needed for quorum)
2. Start with 5 validators, then kill 2 mid-flight
3. Observe: does consensus continue with 3 nodes?
4. **Fix it**: Restore to 6667 bps. Document at what threshold consensus breaks.

### Exercise 4: Large Entry Throughput Test (Advanced)

1. Start localnet
2. Submit an entry with a 500KB payload:
   ```python
   # Use the test script from the session log
   # Modify to include a 'big_field' with 500KB of data
   ```
3. Check if the entry appears in a block
4. Check the QUIC send bytes in the log:
   ```bash
   grep "bytes=.*00$" data/validator-alpha.log | tail -5
   ```
5. **Questions**:
   - What's the maximum entry size you can submit before hitting the 5MB API limit?
   - How does large entry size affect block time?

### Exercise 5: Explorer Entry ID Lookup (Beginner)

1. Submit an entry and note its `entry_id`
2. Open `http://localhost:8885/blocks?q=<your-entry-id>`
3. Verify it redirects to the correct block page
4. Open `http://localhost:4444/entries/lookup/<your-entry-id>`
5. Compare the response with the block page
6. **Questions**:
   - How does the explorer resolve entry_id → block_height?
   - What's the scan limit and why is it important?

### Exercise 6: Namespace Validation (Intermediate)

1. Try submitting an entry to `identity.citizen` with author `forms.commitment`
2. What error do you get?
3. Try submitting with `author: "registry.identity"` but missing `author_public_key` in payload
4. What error do you get?
5. Add a new namespace `test.workshop` with a custom validator to the config
6. Submit a valid entry to it
7. **Questions**:
   - What are the three checks in `validate_entry`?
   - How does `require_signature` work? Trace the crypto verification path.

### Exercise 7: RocksDB Inspection (Advanced)

1. Start localnet, let it produce ~50 blocks
2. Kill the nodes: `pkill -f citizen-node`
3. Inspect the RocksDB store:
   ```bash
   # Install rocksdb CLI (or use a Python script)
   # Check column families: entries, blocks, validators, governance, receipts
   ```
4. List all entries in the `identity.citizen` namespace
5. Find the block containing a specific entry
6. **Questions**:
   - How are entries keyed in RocksDB?
   - What does `prefix_scan` do and why is the boundary check important?

---

## Key Commands Reference

```bash
# Build & test
cd citizen-protocol
cargo build -p citizen-node    # Build node binary
cargo test --workspace          # 225 tests, 0 failures

# Start / stop localnet
./scripts/run_localnet.sh       # Start 5 validators
pkill -f "target/debug/citizen-node"  # Stop all

# Monitor
tail -f data/validator-alpha.log | grep "block finalized"
grep "entry_count=[1-9]" data/validator-*.log  # Blocks with entries
grep "TIMED OUT\|inbox closed" data/validator-*.log  # Deadlock detection

# Submit test entries
python3 scripts/submit_test_entry.py

# Explorer
open http://localhost:8885
# Explorer backend
curl http://localhost:4444/health
# Node API
curl http://127.0.0.1:8081/health
curl http://127.0.0.1:8081/blocks/500
```
