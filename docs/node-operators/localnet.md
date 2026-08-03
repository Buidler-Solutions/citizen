# Localnet

The localnet configuration provides a pre-configured 5-validator network for development and testing.

## Quick Start

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
