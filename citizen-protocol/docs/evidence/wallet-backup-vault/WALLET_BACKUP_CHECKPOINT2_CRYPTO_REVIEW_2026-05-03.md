# Wallet Backup Checkpoint 2 Crypto Review — 2026-05-03

## Scope

Checkpoint 2 closure review for `WALLET_ENCRYPTED_BACKUP_VAULT_IMPLEMENTATION_CHECKLIST.md`:

- Crypto design alignment against existing wallet and off-chain encryption patterns.
- Test-vector coverage for backup vault key derivation, encryption/decryption, and tamper failures.

## Review Inputs

- `citizen-protocol/crates/wallet/src/lib.rs`
- `citizen-protocol/crates/wallet/src/cli.rs`
- `citizen-protocol/docs/WALLET_BACKUP_CRYPTO_POLICY.md`
- `citizen-protocol/docs/OFFCHAIN_ENCRYPTION_REVIEW.md`
- Wallet regression logs under `citizen-protocol/docs/evidence/wallet-backup-vault/`

## Findings

1. **KDF alignment is consistent with repo baseline.**
   - Backup vault encryption path uses Argon2id (`Algorithm::Argon2id`, `Version::V0x13`) and enforces deterministic parameter parsing and failure handling.
   - This matches the documented wallet and off-chain passphrase-derived encryption baseline.

2. **AEAD selection is intentionally scoped and documented.**
   - Backup vault payload protection uses ChaCha20-Poly1305 with strict 12-byte nonce requirements and deterministic decrypt/tamper failure semantics.
   - Hybrid privacy and recipient-wrapped flows continue to use XChaCha20-Poly1305 where 24-byte nonces are part of that separate contract; no implicit interchange is assumed.

3. **Vault format anti-tamper wiring is implemented and validated.**
   - Vault schema/magic/version checks are fail-closed.
   - Slot manifests and authenticated metadata checks are enforced before restore.
   - Rollback/tamper attempts route through deterministic error contract IDs in CLI JSON output.

4. **Checkpoint 2 test-vector requirement is met.**
   - Wallet crate includes deterministic vector assertions for Argon2id + ChaCha20-Poly1305 encrypt/decrypt success plus tamper-failure checks.
   - Compatibility fixture for the v1 vault schema remains pinned and validated by regression tests.

## Maintainer Outcome

- **Wallet maintainer:** checkpoint-2 crypto closure accepted for current `citizen.wallet.backup.v1` scope.
- **Crypto maintainer:** checkpoint-2 crypto closure accepted for current Argon2id + ChaCha20-Poly1305 baseline and deterministic failure contract behavior.

## Follow-On Constraints

- Any migration to `citizen.wallet.backup.v2` must preserve deterministic failure taxonomy and ship explicit migration tooling + compatibility evidence.
- Any AEAD primitive changes require refreshed deterministic vectors and cross-review with off-chain encryption docs before checklist status changes.
