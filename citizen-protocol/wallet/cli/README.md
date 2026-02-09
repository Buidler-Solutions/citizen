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
- Ledger submission and namespace-specific builders are still in progress.
