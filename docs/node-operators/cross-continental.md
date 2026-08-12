# Cross-Continental Validator Deployment

Deploying Citizen validators across multiple continents (US, Europe, Philippines) requires timing tuning, clock synchronization, and careful firewall configuration. This guide covers everything needed for geographically distributed BFT consensus.

## Why QUIC Works for Cross-Continental Consensus

Citizen uses QUIC (via the Quinn library) as its transport layer. QUIC provides several advantages over TCP+TLS for intercontinental validator communication:

| Feature | Benefit |
|---------|---------|
| **Persistent pooled connections** | No per-message TLS handshake — saves ~1 RTT per message |
| **Parallel fan-out broadcast** | All peers receive proposals simultaneously |
| **Stream multiplexing** | Multiple messages share one connection without head-of-line blocking |
| **Built-in keepalive (3s)** | Prevents NAT/firewall timeouts on long-haul links |
| **Generous timeouts (5s)** | Well above worst-case 300ms intercontinental RTT |

## The Two-Round-Trip Consensus Cycle

Citizen's BFT consensus requires 2 network round-trips per block:

```
1. Leader broadcasts proposal  ──→  all validators receive    (1 RTT)
2. Validators broadcast PreVote ──→  leader collects quorum    (1 RTT)
3. Leader broadcasts Commit     ──→  all validators finalize   (1 RTT)
```

With worst-case ~300ms RTT (Europe ↔ Philippines), the critical path is ~600ms. At the default 1-second block time, this leaves only 400ms for validation and signing — tight but workable. For production cross-continental deployments, bump to 2 seconds.

## Typical Intercontinental RTT

| Path | RTT (round-trip) |
|------|-------------------|
| US ↔ Europe | ~80–100ms |
| US ↔ Philippines | ~180–220ms |
| Europe ↔ Philippines | ~250–300ms |

## Timing Configuration

```toml
block_time_millis = 2000          # Default 1000. Bump to 2000 for intercontinental RTT.
heartbeat_interval_millis = 1000  # Default 500. Reduce cross-ocean chatter.
```

These are the only parameters that need adjustment. The QUIC idle timeout (10s), keepalive (3s), proposal timeout (5s), and message handling timeout (5s) are already generous enough for cross-continental latency.

## Clock Synchronization (Critical)

Citizen's handshake admission rejects messages with more than 30 seconds clock skew. All validators must run chrony or NTP.

```bash
sudo apt install -y chrony
sudo systemctl enable chrony && sudo systemctl start chrony

# Verify sync before joining consensus
chronyc tracking
# Last offset must be under 1 second
```

## Firewall Rules

QUIC runs over **UDP**, not TCP:

```bash
# QUIC transport (UDP)
sudo ufw allow 7000/udp

# HTTP API (optional)
sudo ufw allow 8080/tcp
```

## Validator Minimums for Cross-Continental Deployment

| Validators | Max Faulty | Quorum Needed | Tolerates Regional Outage? |
|------------|-----------|---------------|---------------------------|
| 3 | 0 | 3 (100%) | No — all must stay online |
| 4 | 1 | 3 (75%) | Barely |
| 5 | 1 | 4 (80%) | Yes |
| 7 | 2 | 5 (71%) | Yes, robustly |

With 3 validators at >2/3 quorum, all 3 must vote — a single node going down halts consensus. **5 validators minimum** is strongly recommended for cross-continental production.

## Health Monitoring

```bash
# Block height should increment every ~2 seconds
watch -n 2 'curl -s http://localhost:8080/api/v1/status | jq .consensus.latest_height'

# Validator connectivity (should show N-1 peers)
curl -s http://localhost:8080/api/v1/status | jq '.consensus.connected_validators'
```

Block height stalling for >15 seconds indicates a QUIC connectivity issue. The automatic heartbeat-driven block sync protocol handles catching up without operator intervention — a recovering node requests missing blocks from peers automatically.

## Split-Brain Prevention

Citizen's BFT consensus cannot split-brain:

- Quorum requires >2/3 of the **known validator set**
- A block commits only when >2/3 signatures are on the same hash
- Two conflicting blocks cannot both gather >2/3 signatures

No operator action needed — this is enforced by the protocol.

For the full deployment runbook with per-node config templates, TLS certificate generation, launch sequence, and troubleshooting, see `citizen-protocol/docs/CROSS_CONTINENTAL_VALIDATOR_RUNBOOK.md`.
