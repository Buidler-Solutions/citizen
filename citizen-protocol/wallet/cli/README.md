# Citizen Wallet CLI

This folder is a placeholder for a standalone wallet CLI application.

Current status:
- A Rust wallet library and CLI prototype are implemented in `crates/wallet` (keygen, key import, listing, entry signing, signature verification).
- Use `cargo run -p citizen-wallet -- --help` to access the prototype commands.

Planned capabilities:
- Key management (generate/import/export).
- Ledger entry submission.
- Balance and identity lookups per namespace.

Implementation notes will live here as the CLI is built out further.
