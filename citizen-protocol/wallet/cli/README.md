# Citizen Wallet CLI

This folder contains the standalone wallet CLI binary backed by the
`citizen-wallet` library crate.

## Usage
```bash
cargo run -p citizen-wallet-cli -- --help
```

## Status
- Key management, entry signing, and verification are available via the shared
  CLI implementation in `crates/wallet`.
- Namespace-specific signing helpers are available for identity, governance, registry, and audit entry flows.
- Ledger submission and receipt workflows are still in progress.
