# Localnet

The localnet configuration provides a pre-configured 5-validator network for development and testing.

## Lightweight Alternatives

For faster local development without the full 5-node overhead, two lighter configurations are available:

| Mode | Script | Validators | API Ports | QUIC Ports | Use case |
|------|--------|-----------|-----------|------------|----------|
| **Solo** | `scripts/run_solo.sh` | 1 | `9081` | `9200` | API/SDK/wallet dev, fastest startup |
| **Triolet** | `scripts/run_triolet.sh` | 3 | `8091`–`8093` | `9210`–`9212` | Minimum BFT consensus testing (quorum: 3/3) |
| **Full localnet** | `scripts/run_localnet.sh` | 5 | `8081`–`8085` | `9100`–`9104` | Full fault-tolerance, quorum loss, Byzantine testing |

All three modes share the same QUIC TLS certificates (`config/localnet/certs/`) and use separate data directories to avoid state collisions.

### Solo (1 validator)

Single-node mode for rapid API and SDK development. No consensus quorum needed - the single validator produces blocks immediately.

```bash
cd citizen-protocol
scripts/run_solo.sh
```

Health check: `http://localhost:9081/health`

### Triolet (3 validators)

Minimum viable BFT consensus. With 3 validators at >2/3 quorum, all 3 must vote (tolerating 0 faults). Useful for testing consensus message flow, heartbeats, and block sync without the resource overhead of 5 nodes.

```bash
cd citizen-protocol
scripts/run_triolet.sh
```

Health checks: `http://localhost:809{1,2,3}/health`

## Full Localnet (5 validators)

The standard localnet uses a pre-configured 5-validator network for development and testing.

### Quick Start

```bash
cd citizen-protocol
cargo build --release

# Start 5 validators (in separate terminals)
./target/release/citizen-node --config config/localnet/validator-alpha.toml
./target/release/citizen-node --config config/localnet/validator-beta.toml
./target/release/citizen-node --config config/localnet/validator-gamma.toml
./target/release/citizen-node --config config/localnet/validator-delta.toml
./target/release/citizen-node --config config/localnet/validator-epsilon.toml
```

## Validator Set

| Validator | Role | Port (API) | Port (P2P) |
|-----------|------|------------|------------|
| alpha | Leader (round 1) | 7001 | 7000 |
| beta | Validator | 7011 | 7010 |
| gamma | Validator | 7021 | 7020 |
| delta | Validator | 7031 | 7030 |
| epsilon | Validator | 7041 | 7040 |

With 5 validators at >2/3 BFT quorum (6667 bps), the network tolerates 1 faulty node (quorum threshold: ceiling(5 × 6667/10000) = 4 of 5 votes required).

## Resetting Localnet Data

To reset all localnet state:

```bash
# Stop all nodes first
rm -rf citizen-protocol/data/
```

Each validator has its own data directory under `citizen-protocol/data/`.

## Testing with Simulation

The simulation harness automates multi-validator scenarios:

```bash
cd citizen-protocol
cargo test -p citizen-simulation
```

Scenarios tested include:

- Normal operation
- Partial validator failure
- Complete quorum loss and recovery
- Malicious leader behavior
- Byzantine validator subsets
- Network partitions

## BFT Quorum and Multisig

The localnet supports BFT quorum multisig workflows. See:

```bash
cargo test -p citizen-simulation -- multisig
```

This validates that entries requiring multisig approval work correctly with the localnet validator set.

## Connect Your Wallet

Point any wallet surface to `http://localhost:7001` to interact with the localnet:

```bash
citizen-wallet-cli --network localnet --endpoint http://localhost:7001
```

## Bootstrap Script

For single-command localnet startup:

```bash
cd citizen-protocol
./scripts/bootstrap-localnet.sh   # if available
```

Or use the single-validator observer bootstrap for quick testing:

```bash
# See: docs/SINGLE_VALIDATOR_OBSERVER_BOOTSTRAP_SCRIPT_RUNBOOK.md
```
