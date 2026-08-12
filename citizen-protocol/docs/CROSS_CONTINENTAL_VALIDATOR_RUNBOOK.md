# Cross-Continental Validator Deployment Runbook

This runbook covers deploying Citizen validators across multiple continents (e.g., US, Europe, Philippines) using the QUIC transport. It addresses latency tuning, clock synchronization, firewall configuration, and health monitoring for geographically distributed consensus.

## 1. Architecture

```text
┌─────────────────────────────────────────────────────────────────┐
│                    Citizen BFT Consensus                         │
│                                                                 │
│  ┌──────────────┐       QUIC        ┌──────────────┐           │
│  │ Validator-US │◄──────────────────►│ Validator-EU │           │
│  │  (Oregon)    │   RTT: ~80-100ms   │  (Frankfurt) │           │
│  │  QUIC :7000  │                    │  QUIC :7000  │           │
│  └──────┬───────┘                    └──────┬───────┘           │
│         │                                   │                    │
│         │    RTT: ~180-220ms    RTT: ~250-300ms                  │
│         │                                   │                    │
│         └──────────┐    ┌───────────────────┘                    │
│                    ▼    ▼                                        │
│              ┌──────────────┐                                    │
│              │ Validator-PH │                                    │
│              │  (Manila)    │                                    │
│              │  QUIC :7000  │                                    │
│              └──────────────┘                                    │
│                                                                 │
│  Each arrow = persistent pooled QUIC connection                  │
│  Heartbeats every 1s · Gossip every 2s · Block time 2s          │
└─────────────────────────────────────────────────────────────────┘
```

### Why QUIC Works for Cross-Continental Consensus

| Feature | Benefit |
|---------|---------|
| **Persistent pooled connections** | No per-message TLS handshake — saves ~1 RTT per message vs TCP+TLS |
| **Parallel fan-out broadcast** | All peers receive proposals simultaneously via `join_all` |
| **Stream multiplexing** | Multiple consensus messages share one connection without head-of-line blocking |
| **Built-in keepalive (3s)** | Prevents NAT/firewall timeouts on long-haul links |
| **Generous timeouts (5s)** | Well above worst-case 300ms intercontinental RTT |

## 2. Prerequisites

### 2.1 Hardware (Per Node)

- 4 vCPU, 8 GB RAM, 100 GB SSD
- Static public IP address
- UDP port open for QUIC (default: 7000)

### 2.2 Clock Synchronization (Critical)

Citizen's handshake admission rejects messages with >30 seconds clock skew. All validators must run NTP or chrony.

**Ubuntu/Debian:**
```bash
sudo apt update && sudo apt install -y chrony
sudo systemctl enable chrony
sudo systemctl start chrony

# Verify sync before joining consensus
chronyc tracking
# Reference ID    : CA480608 (Stratum 2)
# Last offset     : +0.000123 seconds  ← must be < 1 second
```

**The 30-second skew limit** is enforced at `crates/network/src/lib.rs` admission control. Drift beyond this causes the node to be rejected by all peers.

### 2.3 Firewall Rules

Each validator needs:

```bash
# QUIC transport (UDP — not TCP!)
sudo ufw allow 7000/udp

# HTTP API (optional — only if node serves API)
sudo ufw allow 8080/tcp

# Verify
sudo ufw status
```

> **Common mistake:** QUIC runs over **UDP**, not TCP. Opening TCP port 7000 will not work.

### 2.4 Binary Installation

```bash
# Download the latest citizen-node binary
curl -L https://github.com/greenarmor/citizen-protocol/releases/latest/download/citizen-node-linux-x86_64 -o citizen-node
chmod +x citizen-node
sudo mv citizen-node /usr/local/bin/

# Verify
citizen-node --version
```

For ARM64 servers (e.g., some Philippine hosting providers):
```bash
curl -L https://github.com/greenarmor/citizen-protocol/releases/latest/download/citizen-node-linux-arm64 -o citizen-node
```

## 3. Latency Analysis and Timing Tuning

### 3.1 The Two-Round-Trip Consensus Cycle

Citizen's consensus requires **2 network round-trips** per block:

```
1. Leader broadcasts proposal  ──→  all validators receive    (1 RTT)
2. Validators broadcast PreVote ──→  leader collects quorum    (1 RTT)
3. Leader broadcasts Commit     ──→  all validators finalize   (1 RTT)
```

With worst-case 300ms RTT (Europe ↔ Philippines):
- Steps 1+2 (the critical path): ~600ms
- Leaves ~400ms for validation + signing at 1s block time
- Leaves ~1400ms at 2s block time (recommended)

### 3.2 Recommended Timing Configuration

```toml
# Cross-continental tuning — overrides defaults
block_time_millis = 2000          # Default 1000. Bump to 2000 for intercontinental RTT.
heartbeat_interval_millis = 1000  # Default 500. Reduce cross-ocean chatter.
```

### 3.3 What NOT to Change

These are already generous enough for cross-continental deployment — do not modify:

| Parameter | Current Value | Why It's Fine |
|-----------|--------------|---------------|
| QUIC idle timeout | 10s | 33× worst-case RTT |
| QUIC keepalive | 3s | Prevents NAT expiry |
| Proposal timeout | 5s | 16× worst-case RTT |
| Message handling timeout | 5s | 16× worst-case RTT |
| Write timeout | 5s | Per-message write limit |
| Max clock skew | 30s | Handled by chrony/ntp |
| Connect timeout | 5s | Initial QUIC connection establishment |

### 3.4 Expected Block Finality

| Deployment | Block Time | Observed Finality |
|------------|-----------|-------------------|
| Same region (localnet) | 1s | ~1s |
| Cross-region (US + EU) | 2s | ~2–3s |
| Cross-continental (US + EU + PH) | 2s | ~2–4s |

Finality is **deterministic** — once committed, a block is final. There are no probabilistic confirmations.

## 4. Node Configuration

### 4.1 Validator-US (Oregon)

```toml
validator_id = "validator-us"
block_time_millis = 2000
quorum_bps = 6667
signing_key_hex = "GENERATE_UNIQUE_KEY_FOR_THIS_NODE"
manifest_enforce = false
api_port = 8080
data_dir = "/var/lib/citizen/data"
bind_addr = "0.0.0.0:7000"
network_key_rotation_secs = 3600

# --- Clock skew protection ---
# Ensure chrony/ntpd is running. Max skew = 30s.

# --- Peers (other validators) ---
[[peers]]
validator_id = "validator-eu"
address = "EU_PUBLIC_IP:7000"

[[peers]]
validator_id = "validator-ph"
address = "PH_PUBLIC_IP:7000"

# --- Validator set registry ---
[[validators]]
validator_id = "validator-us"
public_key = "US_NODE_PUBLIC_KEY"
anchors = ["org:us-oregon"]

[[validators]]
validator_id = "validator-eu"
public_key = "EU_NODE_PUBLIC_KEY"
anchors = ["org:eu-frankfurt"]

[[validators]]
validator_id = "validator-ph"
public_key = "PH_NODE_PUBLIC_KEY"
anchors = ["org:ph-manila"]

# --- QUIC TLS (generate per-node certs, see §5) ---
[quic_tls]
ca_cert_path = "/etc/citizen/certs/ca.der"
cert_chain_path = "/etc/citizen/certs/validator-us.der"
private_key_path = "/etc/citizen/certs/validator-us.key.der"

# --- Namespace rate limits ---
[namespace_rate_limits]
"identity.citizen" = 20
"governance.vote" = 50
"builder.credits" = 20
"consent.receipt" = 30
"forms.commitment" = 30

# --- Namespaces (same on all validators) ---
[[namespaces]]
descriptor.namespace = "identity.citizen"
descriptor.version = 1
descriptor.rules_hash = "sha256:identity-v1"
descriptor.governed_by = "governance.vote"
writers = ["registry.identity"]
[[namespaces.validators]]
name = "require_signature"
config = {}

# ... repeat for governance.vote, builder.credits, consent.receipt, etc.
```

### 4.2 Validator-EU (Frankfurt)

```toml
validator_id = "validator-eu"
block_time_millis = 2000
quorum_bps = 6667
signing_key_hex = "GENERATE_UNIQUE_KEY_FOR_THIS_NODE"
manifest_enforce = false
api_port = 8080
data_dir = "/var/lib/citizen/data"
bind_addr = "0.0.0.0:7000"
network_key_rotation_secs = 3600

[[peers]]
validator_id = "validator-us"
address = "US_PUBLIC_IP:7000"

[[peers]]
validator_id = "validator-ph"
address = "PH_PUBLIC_IP:7000"

# ... validators[], quic_tls[], namespaces[] identical to US config
# (same network_id, same genesis_hash, same namespace rulesets)
```

### 4.3 Validator-PH (Manila)

```toml
validator_id = "validator-ph"
block_time_millis = 2000
quorum_bps = 6667
signing_key_hex = "GENERATE_UNIQUE_KEY_FOR_THIS_NODE"
manifest_enforce = false
api_port = 8080
data_dir = "/var/lib/citizen/data"
bind_addr = "0.0.0.0:7000"
network_key_rotation_secs = 3600

[[peers]]
validator_id = "validator-us"
address = "US_PUBLIC_IP:7000"

[[peers]]
validator_id = "validator-eu"
address = "EU_PUBLIC_IP:7000"

# ... validators[], quic_tls[], namespaces[] identical to US config
```

## 5. TLS Certificate Generation

QUIC requires TLS certificates. Generate a shared CA and per-node certs:

### 5.1 Generate CA and Node Certs (Run Once, on Any Secure Machine)

```bash
mkdir -p citizen-certs && cd citizen-certs

# Generate CA key and self-signed cert
openssl ecparam -genkey -name prime256v1 -out ca.key
openssl req -new -x509 -key ca.key -out ca.pem -days 3650 \
  -subj "/CN=citizen-ca" -out ca.pem

# Generate per-node keys and certs (repeat for each validator)
for NODE in validator-us validator-eu validator-ph; do
  openssl ecparam -genkey -name prime256v1 -out ${NODE}.key
  openssl req -new -key ${NODE}.key -out ${NODE}.csr \
    -subj "/CN=citizen.local"
  openssl x509 -req -in ${NODE}.csr -CA ca.pem -CAkey ca.key \
    -CAcreateserial -out ${NODE}.pem -days 3650

  # Convert to DER format (Citizen reads DER)
  openssl x509 -in ${NODE}.pem -outform DER -out ${NODE}.der
  openssl ec -in ${NODE}.key -outform DER -out ${NODE}.key.der
done

# Convert CA to DER
openssl x509 -in ca.pem -outform DER -out ca.der
```

### 5.2 Distribute Certs to Each Node

```bash
# On each validator:
sudo mkdir -p /etc/citizen/certs

# Copy the appropriate files (via scp or your secure channel):
# - ca.der (shared across all nodes)
# - validator-XX.der (this node's cert)
# - validator-XX.key.der (this node's private key)

sudo chmod 600 /etc/citizen/certs/*.key.der
```

## 6. Launch Sequence

### 6.1 Generate Signing Keys (On Each Node)

```bash
# Each validator needs a unique Ed25519 signing key
# Generate using the wallet CLI:
citizen-wallet-cli generate-keypair
# Copy the private key hex into signing_key_hex in the config
```

### 6.2 Start Validators (Within 30 Seconds of Each Other)

```bash
# On each node:
citizen-node --config /etc/citizen/validator.toml > /var/log/citizen-node.log 2>&1 &
```

> **Why 30 seconds?** The handshake admission control checks clock skew (30s limit) and connection timeouts (5s). Starting within 30 seconds ensures all nodes are present for the first consensus round without triggering view changes.

### 6.3 Verify Each Node Is Running

```bash
# Check the process
ps aux | grep citizen-node

# Check the API is responding
curl http://localhost:8080/api/v1/health

# Check consensus status
curl http://localhost:8080/api/v1/status | jq .consensus

# Expected: block height incrementing, validator count = 3
```

## 7. Health Monitoring

### 7.1 Key Metrics to Watch

```bash
# Block height — should increment every ~2 seconds
watch -n 2 'curl -s http://localhost:8080/api/v1/status | jq .consensus.latest_height'

# Validator connectivity
curl -s http://localhost:8080/api/v1/status | jq '.consensus.connected_validators'

# QUIC connection health (look for connection errors in logs)
tail -f /var/log/citizen-node.log | grep -E "quic|connection|timeout|sync"
```

### 7.2 Health Check Script

```bash
#!/bin/bash
# /usr/local/bin/citizen-health.sh

NODE_URL="http://localhost:8080"
STATUS=$(curl -s ${NODE_URL}/api/v1/status)
HEIGHT=$(echo $STATUS | jq -r '.consensus.latest_height')
VALS=$(echo $STATUS | jq -r '.consensus.connected_validators')
SYNCED=$(echo $STATUS | jq -r '.consensus.synced')

echo "Block height: ${HEIGHT}"
echo "Connected validators: ${VALS}"
echo "Synced: ${SYNCED}"

# Alert if height hasn't advanced in 10 seconds
PREV_HEIGHT=${HEIGHT}
sleep 10
NEW_HEIGHT=$(curl -s ${NODE_URL}/api/v1/status | jq -r '.consensus.latest_height')

if [ "$NEW_HEIGHT" -le "$PREV_HEIGHT" ]; then
  echo "WARNING: Block height stalled! Check QUIC connectivity."
  exit 1
fi

echo "OK: Height advancing (${PREV_HEIGHT} → ${NEW_HEIGHT})"
```

### 7.3 What Healthy Looks Like

```
Block height: 142
Connected validators: 2     ← 2 peers (3 total including self)
Synced: true

OK: Height advancing (142 → 143)
```

### 7.4 Grafana/Prometheus (Optional)

Expose metrics via the HTTP API and scrape with Prometheus:

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'citizen-validator-us'
    static_configs:
      - targets: ['US_PUBLIC_IP:8080']
  - job_name: 'citizen-validator-eu'
    static_configs:
      - targets: ['EU_PUBLIC_IP:8080']
  - job_name: 'citizen-validator-ph'
    static_configs:
      - targets: ['PH_PUBLIC_IP:8080']
```

Key alerts:
- `block_height` stalls for >15 seconds → QUIC connectivity issue
- `connected_validators` drops below `N-1` → network partition or peer failure
- Clock skew warnings in logs → check chrony on offending node

## 8. Troubleshooting

### 8.1 Nodes Cannot Connect

**Symptom:** Logs show `"connection refused"` or `"timeout connecting to peer"`.

```bash
# 1. Verify UDP port is open (QUIC uses UDP!)
sudo ufw status | grep 7000
# If missing: sudo ufw allow 7000/udp

# 2. Test QUIC reachability from another node
# (QUIC handshake test — should return quickly)
nc -u -z -w5 EU_PUBLIC_IP 7000 && echo "UDP reachable" || echo "BLOCKED"

# 3. Check bind address — must be 0.0.0.0, not 127.0.0.1
grep bind_addr /etc/citizen/validator.toml
# Should be: bind_addr = "0.0.0.0:7000"
```

### 8.2 Clock Skew Rejection

**Symptom:** Logs show `"clock skew too large"` or `"handshake rejected: clock_skew"`.

```bash
# Check clock sync on the rejected node
chronyc tracking

# Force immediate sync
sudo chronyc -a makestep

# Verify skew is under 1 second
chronyc tracking | grep "Last offset"
```

### 8.3 Block Height Stalled

**Symptom:** Height not advancing for >10 seconds.

```bash
# 1. Check if quorum is reachable
# With 3 validators, need 3 votes (ceiling(3 × 6667/10000) = 3)
# All 3 must be connected and voting

# 2. Check QUIC connections in logs
grep -E "broadcast|unicast|failed" /var/log/citizen-node.log | tail -20

# 3. Restart consensus (safe — committed blocks are permanent)
kill $(pgrep citizen-node)
citizen-node --config /etc/citizen/validator.toml > /var/log/citizen-node.log 2>&1 &
# Node will sync from peers automatically via heartbeat-driven sync
```

### 8.4 Node Behind (Catching Up Slowly)

**Symptom:** One node reports lower height than others.

This is normal — the node is syncing. The heartbeat-driven sync protocol handles it automatically:

```
1. Heartbeat from peer reports higher height
2. Node sends SyncRequest for missing blocks (up to 100)
3. Peer responds with up to 50 blocks per SyncResponse
4. Blocks applied contiguously with full commit-proof verification
5. Repeat until caught up
```

Do NOT manually intervene. If sync is very slow (e.g., thousands of blocks behind), the bottleneck is the 50-blocks-per-response cap × 100-blocks-per-request range. At ~1 round-trip per batch, catching up 10,000 blocks takes ~200 round-trips (~60 seconds at 300ms RTT).

### 8.5 High Latency Between Specific Nodes

**Symptom:** Logs show consistent timeouts between two specific validators.

```bash
# Measure actual RTT between the two nodes
ping -c 10 OTHER_NODE_PUBLIC_IP

# If RTT > 500ms, consider:
# 1. Checking for network routing issues (mtr)
mtr -n OTHER_NODE_PUBLIC_IP

# 2. Verifying the hosting provider's network quality
# 3. If RTT is genuinely >500ms, bump block_time_millis to 3000
```

## 9. Adding a 4th or 5th Validator

Adding validators improves fault tolerance (3 nodes tolerate 0 faults; 4 tolerates 1; 5 tolerates 1):

```text
| Validators | Max Faulty | Quorum Needed | Tolerates Partition? |
|------------|-----------|---------------|----------------------|
| 3          | 0         | 3 (100%)      | No                   |
| 4          | 1         | 3 (75%)       | Yes (barely)         |
| 5          | 1         | 4 (80%)       | Yes                  |
| 7          | 2         | 5 (71%)       | Yes                  |
```

To add a new validator:

1. Generate signing key and TLS cert for the new node
2. Add the new validator's `[[validators]]` entry and `[[peers]]` entry to **all** existing configs
3. Add existing validators to the new node's `[[peers]]` list
4. Submit a governance proposal to activate the new validator
5. Start the new node — it will sync from peers and join consensus

> **With 3 validators at >2/3 quorum, all 3 must vote.** A single node going down halts consensus. For production cross-continental deployment, **5 validators minimum** is strongly recommended (tolerates 1 fault, which is likely given intercontinental latency).

## 10. Disaster Recovery

### 10.1 Regional Failure

If an entire region goes offline (e.g., Philippine data center loses power):

- **3-validator network:** Consensus halts (only 2 of 3 remain, no quorum)
- **5-validator network:** Consensus continues (3 of 5 remaining = quorum)

Recovery:
1. Restore the failed node from RocksDB backup
2. Start the node — heartbeat-driven sync catches it up automatically
3. No manual intervention needed once the node is back online

### 10.2 RocksDB Backup (Per Node)

```bash
# Create a snapshot
sudo tar -czf /backups/citizen-$(date +%Y%m%d-%H%M).tar.gz /var/lib/citizen/data/

# Verify integrity
sha256sum /backups/citizen-*.tar.gz > /backpos/checksums.txt
```

Recommended cadence: every 5 minutes for validators (RPO ≤ 5 minutes).

### 10.3 Split-Brain Prevention

Citizen's BFT consensus cannot split-brain because:
- Quorum requires >2/3 of the **known validator set** (not just "connected" validators)
- A block is only committed when >2/3 signatures are on the same hash
- Two conflicting blocks cannot both gather >2/3 signatures (the sets must overlap by at least 1 honest node)

No operator action needed — this is enforced by the protocol.

## 11. Summary Checklist

| Step | Command/Action | Done |
|------|---------------|------|
| Install chrony | `sudo apt install chrony && chronyc tracking` | ☐ |
| Open UDP port | `sudo ufw allow 7000/udp` | ☐ |
| Install binary | `citizen-node --version` | ☐ |
| Generate keys | `citizen-wallet-cli generate-keypair` | ☐ |
| Generate TLS certs | See §5 | ☐ |
| Set `block_time_millis = 2000` | In validator config | ☐ |
| Set `bind_addr = "0.0.0.0:7000"` | In validator config | ☐ |
| Configure peers with public IPs | In validator config | ☐ |
| Share validator registry across nodes | Identical `[[validators]]` blocks | ☐ |
| Start all nodes within 30s | `citizen-node --config ... &` | ☐ |
| Verify block height advancing | `curl localhost:8080/api/v1/status` | ☐ |
| Set up health monitoring | See §7.2 | ☐ |
| Configure RocksDB backups | See §10.2 | ☐ |
