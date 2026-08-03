# Running a Node

Citizen nodes can operate as **validators** (consensus participants) or **observers** (read-only replicas).

## Prerequisites

- Rust 1.75+
- Linux or macOS (production), any OS (development)
- Open firewall ports for QUIC (consensus) and HTTP (API)

## Build

```bash
cd citizen-protocol
cargo build --release
```

## Node Configuration

Node configuration is specified via TOML files. See `config/localnet/` for example configurations.

Key configuration fields:

```toml
[node]
node_id = "validator-alpha"
role = "validator"          # or "observer"
data_dir = "./data"

[network]
listen_addr = "0.0.0.0:7000"
bootstrap_peers = ["validator-beta:7000", "validator-gamma:7000"]

[api]
listen_addr = "0.0.0.0:7001"

[consensus]
quorum_threshold = 0.8
view_timeout_ms = 5000

[storage]
path = "./data"
```

## Starting a Validator

```bash
./target/release/citizen-node --config config/validator.toml
```

On startup, the node will:

1. Load configuration and admission manifest
2. Run admission preflight checks
3. Open RocksDB storage
4. Boot configured namespaces
5. Connect to bootstrap peers
6. Start the HTTP API server
7. Join consensus (if validator) or begin replicating (if observer)

## Starting an Observer

```bash
./target/release/citizen-node --config config/observer.toml
```

Observers do not participate in voting but replicate the full ledger and serve API requests.

## Verifying Node Health

```bash
curl http://localhost:7001/health
```

```json
{
  "status": "healthy",
  "node_id": "validator-alpha",
  "role": "validator",
  "head_height": 42,
  "peers": 4
}
```

## Node Identity

Each node has a cryptographic identity generated during setup:

```bash
./target/release/citizen-node --generate-identity
```

This produces a node identity key pair that is used for peer authentication and must be registered with the network's admission system.

## Storage Management

The node uses RocksDB. Key data:

- `data/` — RocksDB database files
- `data/IDENTITY` — Node identity
- `data/CURRENT` — Current storage manifest

!!! warning
    Never delete `data/IDENTITY` — this is your node's cryptographic identity. Losing it requires generating a new identity and re-admission to the network.

## Logs

By default, the node logs to stdout. For production, redirect to a log file:

```bash
./target/release/citizen-node --config config/validator.toml 2>&1 | tee /var/log/citizen-node.log
```
