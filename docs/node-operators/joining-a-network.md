# Joining an Existing Citizen Network

This guide walks through the complete process of adding a new validator or observer node to an existing Citizen Protocol network — from generating your identity to syncing blocks and participating in consensus.

---

## How Joining Works

When a new node joins an existing network, it does **not** need to be present at genesis. The block sync protocol handles everything:

```
New Node                              Existing Validators
────────                              ───────────────────
1. Loads config + key material
2. Connects to bootstrap peers ──►    (QUIC handshake)
3. Sends SyncRequest(from=1)   ──►    Responds with blocks 1–50
4. Verifies BFT commit proofs         (each block: >2/3 sigs)
5. Requests next batch          ──►    Responds with blocks 51–100
   ... repeats until caught up ...
6. Enters consensus loop        ──►    Now voting on new blocks
```

**Key properties:**

- Sync happens over **QUIC**, not HTTP. No API access required.
- Each block carries a BFT commit proof — >2/3 validator signatures. A malicious peer **cannot inject fake blocks**.
- The node applies blocks contiguously (`latest_height + 1` only). Gaps trigger re-request.
- Once caught up, the node enters the normal consensus event loop.

For observers (read-only nodes), the process is identical except they skip step 6 — they replicate but don't vote.

---

## Prerequisites

- Rust 1.75+ with `wasm32-unknown-unknown` target
- Built node binary: `cargo build --release`
- Python 3.8+ with `pynacl`: `pip3 install pynacl`
- Network access to bootstrap peers (QUIC ports open)
- TLS certificate signed by the network's Certificate Authority
- The network's genesis namespace definitions (`triolet-namespaces.toml`)
- The network's current validator set (`triolet-network.toml`)

---

## Step 1: Generate Your Node Identity

Every node has a cryptographic identity — an Ed25519 keypair used for peer authentication and block signing.

```bash
cd citizen-protocol

# Generate a random identity
python3 scripts/generate_node_identity.py --name my-validator
```

**Output:**
```
======================================================================
  NODE IDENTITY GENERATED
======================================================================

  Node ID:            my-validator
  Signing key (hex):  a1b2c3d4...  (64 hex chars — KEEP SECRET)
  Public key (hex):   f0e1d2c3...  (share with network operators)
  Validator DID:      did:key:ed25519:f0e1d2c3...
```

> **Security**: The signing key is your node's private identity. Store it securely. Losing it requires generating a new identity and re-admission to the network.

---

## Step 2: Obtain or Generate TLS Certificates

QUIC connections require TLS. The network uses a shared Certificate Authority (CA).

### Option A: Network operator provides certs

Ask the network operator to generate a certificate for your `node_id` signed by the network CA.

### Option B: Generate your own (if you have CA access)

```bash
./scripts/generate_quic_cert.sh \
  --ca-cert config/certs/ca.der \
  --ca-key config/certs/ca.key.der \
  --name my-validator \
  --output config/certs/
```

This produces:
- `config/certs/my-validator.der` — your TLS certificate chain
- `config/certs/my-validator.key.der` — your TLS private key

---

## Step 3: Generate Your Node Config

Use the `generate_join_config.py` script to create a complete config from the network definition.

### From a network definition file (recommended)

```bash
python3 scripts/generate_join_config.py \
    --node-id my-validator \
    --signing-key a1b2c3d4...your-64-char-key-hex \
    --api-port 9001 \
    --bind-addr 0.0.0.0:9200 \
    --network-file config/join-kit/triolet-network.toml \
    --genesis-ns-file config/join-kit/triolet-namespaces.toml \
    --tls-cert config/certs/my-validator.der \
    --tls-key config/certs/my-validator.key.der \
    --output config/my-validator.toml
```

### Manually specifying validators and peers

```bash
python3 scripts/generate_join_config.py \
    --node-id my-validator \
    --signing-key a1b2c3d4... \
    --api-port 9001 \
    --bind-addr 0.0.0.0:9200 \
    --existing-validators \
        alpha:4620ab7d...:org:alpha \
        beta:dcb38143...:org:beta \
        gamma:1482e33d...:org:gamma \
    --bootstrap-peers \
        alpha:192.168.1.10:9210 \
        beta:192.168.1.11:9211 \
        gamma:192.168.1.12:9212 \
    --genesis-ns-file config/join-kit/triolet-namespaces.toml \
    --output config/my-validator.toml
```

**What the script does:**

- Merges your node identity with the network's validator set
- Adds your node to the `[[validators]]` list
- Includes all namespace definitions from genesis
- Configures rate limits and TLS paths
- Outputs a ready-to-use `citizen-node` config

**Output:**
```
  ✓ Config written to: config/my-validator.toml
  ✓ Validators in set: 4
  ✓ Bootstrap peers:   3

  Start your node:
    ./target/release/citizen-node --config config/my-validator.toml
```

---

## Step 4: Share Your Public Key (Production Only)

For production networks with governance-gated admission, existing validators must vote to admit your node.

```bash
# You (the joining operator) submit an admission proposal
citizen-wallet-cli propose-validator-admission \
    --validator-id my-validator \
    --public-key f0e1d2c3... \
    --anchors org:my-validator \
    --network testnet
```

The governance lifecycle:

```
Proposal → Voting Period → >2/3 Quorum → Approval → Node Joins
```

Once approved, start your node — it will sync and enter consensus automatically.

> **Note**: For local development with `manifest_enforce = false`, governance admission is skipped. The node connects and syncs immediately.

---

## Step 5: Start Your Node

```bash
./target/release/citizen-node --config config/my-validator.toml
```

**Startup sequence:**

```
[INFO] Loading config: config/my-validator.toml
[INFO] Opening RocksDB at: data/my-validator
[INFO] Booting namespaces: identity.citizen, governance.vote, civic.proposal, ...
[INFO] Connecting to bootstrap peers: alpha, beta, gamma
[INFO] Starting block sync from height 1
[INFO] Synced block 50/1247 (4%)
[INFO] Synced block 150/1247 (12%)
...
[INFO] Block sync complete. Height: 1247
[INFO] Entering consensus event loop. Role: validator
[INFO] Node running. API on port 9001
```

## Step 6: Verify Your Node is Synced

```bash
# Check health
curl http://localhost:9001/health

# Check consensus status
curl http://localhost:9001/consensus/status

# Compare block height with other validators
curl http://localhost:9001/health | jq '.head_height'
```

Expected response:

```json
{
  "status": "healthy",
  "node_id": "my-validator",
  "role": "validator",
  "head_height": 1247,
  "peers": 3
}
```

If `head_height` matches other validators and `peers` > 0, your node is fully synced and participating.

---

## Exercises

### Exercise 1: Join as an Observer

Observers replicate the ledger but don't vote. Useful for read-heavy services.

1. Generate two identities: `observer-east` and `observer-west`
2. Generate configs for both as observers
3. Start both pointing at the same triolet network
4. Verify both show the same `head_height` as validators
5. Submit an entry via a validator and verify both observers see it

**Hint**: Observers don't need `manifest_enforce` or governance admission. They just need the validator set and bootstrap peers.

### Exercise 2: Governance-Gated Admission

Simulate the full production admission flow.

1. Start a fresh triolet network with `manifest_enforce = true`
2. Generate a new validator identity
3. Submit an admission proposal through governance
4. Vote on the proposal from the existing validators
5. Verify the proposal passes (>2/3 quorum)
6. Start the new validator and verify it joins consensus

**Check**: After joining, the quorum math should update. With 3 validators, `ceiling(3 × 6667/10000) = 2` votes needed. With 4, `ceiling(4 × 6667/10000) = 3` votes needed.

### Exercise 3: Network Partition Recovery

Test what happens when a node is disconnected and reconnects.

1. Start a 3-validator triolet network
2. Start a 4th validator that syncs and joins
3. Kill the 4th validator (`kill -9`)
4. Submit 50 entries via the remaining validators
5. Restart the 4th validator
6. Verify it syncs the missed blocks and re-enters consensus
7. Verify all entries submitted during the partition are present

### Exercise 4: Multi-Region Join

Simulate a geographically distributed validator joining.

1. Use `--bind-addr` to bind validators to different loopback IPs (`127.0.0.2`, `127.0.0.3`, etc.)
2. Generate a new validator for a "remote" region
3. Configure it with the correct bootstrap peers
4. Start it and measure sync time
5. Monitor `head_height` convergence using `watch curl http://localhost:XXXX/health`

**Discussion**: How does sync time scale with block count? What if a validator has been offline for months?

---

## Troubleshooting

### "Connection refused" on bootstrap

```
ERROR: Failed to connect to bootstrap peer validator-alpha at 127.0.0.1:9210
```

- Verify the peer's QUIC port is open and not firewalled
- Check the address in your `[[peers]]` section matches the peer's `bind_addr`
- Ensure TLS certificates are valid and signed by the same CA

### "Genesis hash mismatch"

```
ERROR: Genesis hash does not match network. Expected: abc123..., Got: def456...
```

- Your `--genesis-ns-file` must be **identical** to the genesis used by existing validators
- Namespace descriptors, versions, and rules_hashes must match exactly
- Re-export namespaces from an existing validator's config

### "Validator key not in validator set"

```
ERROR: Peer validator-delta public key not recognized
```

- Your public key must be added to the `[[validators]]` list in all existing nodes' configs
- For governance-gated networks, the admission proposal must be approved first
- Verify the public key in your config matches the one you shared with operators

### "Block sync stuck at height X"

```
[INFO] Synced block 500/1247 (40%)
... (no progress for >30 seconds)
```

- The peer serving blocks may have disconnected. The sync will retry with other peers.
- Check network connectivity between your node and all bootstrap peers.
- If all peers are unreachable, verify firewall rules on both sides.

### "API port already in use"

```
ERROR: Address already in use (os error 48)
```

- Choose a unique `--api-port` for each node
- Use `lsof -i :9001` to find the process using the port
- Observer and validator on the same machine need different ports

---

## Config Reference

| Field | Required | Description |
|---|---|---|
| `validator_id` | Yes | Unique node identifier |
| `signing_key_hex` | Yes | 64-char Ed25519 seed (keep secret) |
| `api_port` | Yes | HTTP API port (unique per machine) |
| `bind_addr` | Yes | QUIC P2P listen address |
| `quorum_bps` | Yes | Must match network (default 6667) |
| `data_dir` | No | Custom data directory (default: `data/<validator_id>`) |
| `manifest_enforce` | No | Require governance admission (default: false) |
| `quic_tls.ca_cert_path` | Yes | Network CA certificate |
| `quic_tls.cert_chain_path` | Yes | Your TLS certificate |
| `quic_tls.private_key_path` | Yes | Your TLS private key |
| `[[validators]]` | Yes | All validators in the network (existing + you) |
| `[[peers]]` | Yes | Bootstrap peer addresses |
| `[[namespaces]]` | Yes | Genesis namespace definitions |

---

## Next Steps

- [Run a full validator node](running-a-node.md)
- [Validator operations guide](validator.md)
- [Understanding the consensus model](../protocol/consensus.md)
- [Localnet development setup](localnet.md)
