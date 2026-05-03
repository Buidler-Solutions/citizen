# wallet/backup-vault

Shared backup-vault extraction seam for desktop and extension clients.

## Why this package exists

Checkpoint 1 in `WALLET_ENCRYPTED_BACKUP_VAULT_IMPLEMENTATION_CHECKLIST.md` keeps
`wallet/backup-vault` as the future extraction target when backup-vault contract
sharing pressure grows across:

- `wallet/desktop` (Tauri runtime bridge)
- `vaultier` desktop UI runtime contract tests
- `wallet/browser` extension backup flows

This directory now hosts the initial shared contract assets so downstream clients
can migrate without changing the canonical wallet-core implementation location.

## Scope

- Canonical JSON schema mirrors `citizen.wallet.backup.cli.v1` top-level envelope
  fields used by init/verify/restore flows.
- This package intentionally does **not** move cryptographic runtime logic out of
  `citizen-protocol/crates/wallet`; it only establishes the package-layout seam.

## Current contract artifact

- `schemas/backup-command-envelope.v1.schema.json`

## Migration intent

When extension/desktop runtime parity requires stronger sharing:

1. Promote this directory into a versioned workspace package.
2. Publish typed bindings for Rust/TypeScript consumers.
3. Keep CLI envelope compatibility with `citizen.wallet.backup.cli.v1`.
