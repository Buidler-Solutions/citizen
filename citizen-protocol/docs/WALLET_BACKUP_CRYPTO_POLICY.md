# Wallet Backup Vault Cryptography Policy (CLI/Vaultier)

## Scope

This policy freezes the cryptographic contract used by the current wallet backup implementation and Vaultier headless/runtime bridge paths.

- Applies to `wallet backup init`, `wallet backup verify`, `wallet backup restore`, and Vaultier headless parity commands.
- Tracks the current contract version emitted by tooling: `2026-05-01`.

## AEAD and Nonce/IV Policy

### Algorithm

- AEAD primitive: **ChaCha20-Poly1305**.
- Authentication tag: standard 16-byte Poly1305 tag (implicit in AEAD payload handling).

### Nonce policy

- Nonce length is **exactly 12 bytes** for all backup payload encryption/decryption operations.
- Any nonce length mismatch must fail closed with deterministic validation failure semantics.
- Nonce values must be unique per encryption operation under a given key.

### Associated data

- Header/version/context metadata required for restore/verify integrity must be bound as AEAD associated data where applicable.
- Any associated-data mismatch must surface deterministic tamper/integrity failure behavior.

## KDF Policy (Argon2id)

### Baseline

- KDF algorithm: **Argon2id**.
- Profile selection is explicit and exported in machine-readable outputs.

### Supported profiles

1. `balanced` (default for standard operator workflows)
   - memory: `131072 KiB`
   - iterations: `3`
   - parallelism: `1`
2. `critical-hardened` (for higher-sensitivity custody material)
   - memory: `262144 KiB`
   - iterations: `4`
   - parallelism: `1`

### Operator hardening guidance

- Prefer `critical-hardened` for critical-slot backups, especially removable-media custody.
- Use `balanced` only when endpoint performance constraints would otherwise block reliable backup verification cadence.
- Treat profile downgrade as a documented risk acceptance decision in runbooks.

## Deterministic Failure Semantics

- Wrong passphrase, nonce/format mismatch, manifest/signature mismatch, and tamper indicators must map to deterministic command outcomes and error taxonomy.
- Verify/restore automation must consume contract-versioned JSON output and avoid heuristic parsing.

## Implementation Alignment Notes

This policy aligns with current implementation behavior already reflected in:

- wallet backup command JSON contract metadata,
- deterministic nonce validation in decrypt path,
- signed-manifest enforcement in verify/restore flows,
- Argon2id profile metadata in backup-init paths.

Further changes to algorithms, parameters, or nonce policy require checklist/status updates and fixture refreshes before release gates are considered complete.
