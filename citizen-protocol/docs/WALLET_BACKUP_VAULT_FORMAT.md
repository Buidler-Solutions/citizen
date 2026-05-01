# Wallet Backup Vault Format Contract (`citizen.wallet.backup.v1`)

## Purpose

This document freezes the current wallet CLI backup vault file contract used by:

- `wallet backup init`
- `wallet backup add-slot`
- `wallet backup export-credentials`
- `wallet backup verify`
- `wallet backup restore`

It is the format-level companion to:

- `WALLET_BACKUP_CRYPTO_POLICY.md` (crypto + KDF policy)
- `WALLET_BACKUP_DISASTER_RECOVERY_RUNBOOK.md` (operator restore drills)
- `WALLET_ENCRYPTED_BACKUP_VAULT_THREAT_MODEL.md` (threat boundaries)

## Current stable identifiers

- Vault schema: `citizen.wallet.backup.v1`
- Vault version: `1`
- Signed manifest schema: `citizen.wallet.backup.manifest.v1`

CLI JSON automation contract references this format via `contract_version: "citizen.wallet.backup.cli.v1"` in `--json` outputs.

## Top-level vault object (`v1`)

Required top-level keys:

- `schema` (string)
- `version` (integer)
- `portable_label` (string or null)
- `created_at` (unix timestamp seconds)
- `slots` (array)

Validation behavior:

- `schema != citizen.wallet.backup.v1` is rejected as deterministic error `unsupported_schema`.
- `slots` must contain role entries referenced by restore/verify flows; missing role maps to deterministic error `slot_not_found`.

## Slot object (`decoy` / `critical`)

Each slot entry contains:

- `role`: one of `decoy` or `critical`
- `scopes`: exported credential scope list
- `encrypted_payload`:
  - `algorithm` (current fixture label: `argon2id-aes256gcm`)
  - `ciphertext_hex`
  - `nonce_hex`
  - `salt_hex`
  - `kdf` (`argon2id`)
  - `kdf_params` (`memory_kib`, `iterations`, `parallelism`, `output_length`)
- `exported_at` (unix timestamp seconds)
- `payload_sha256`
- `signed_manifest`:
  - `schema` (`citizen.wallet.backup.manifest.v1`)
  - `key_id`
  - `signed_at`
  - `payload_sha256`

Validation behavior:

- decrypt failure / malformed envelope => `decrypt_failed` or `invalid_payload` depending on failure class.
- payload hash mismatch => `checksum_mismatch`.
- missing/invalid signed manifest => `invalid_payload`.

## Compatibility and migration policy

### v1 guarantees

- Wallet CLI maintains read/write compatibility for `citizen.wallet.backup.v1` within the same major schema/version.
- Deterministic machine error identifiers are stable for automation:
  - `unsupported_schema`
  - `slot_not_found`
  - `decrypt_failed`
  - `checksum_mismatch`
  - `invalid_payload`

### Forward-reject policy

- Unknown future schema/version values are rejected (fail closed) instead of best-effort parsing.
- Operators should treat `unsupported_schema` as a migration-required signal.

### Future migration requirement

- Any future vault format (`v2+`) must ship with an explicit migration command/workflow.
- Migration must preserve deterministic verification and restore outcomes (including manifest enforcement and checksum/tamper checks).
- This document should be versioned by appending new sections instead of rewriting v1 semantics.

## Evidence / implementation anchors

- Fixture contract: `crates/wallet/tests/fixtures/backup_vault_schema_v1_fixture.json`
- Compatibility test: `backup_vault_schema_fixture_remains_compatible`
- CLI parsing/enforcement: `crates/wallet/src/cli.rs` backup load/verify/restore paths
