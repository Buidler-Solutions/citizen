# Wallet Encrypted Backup Vault Threat Model (v1alpha1)

## Scope and status

This document covers the currently implemented wallet backup vault flow in `crates/wallet` CLI:

- `wallet backup init`
- `wallet backup add-slot`
- `wallet backup export-credentials`
- `wallet backup verify`
- `wallet backup restore`

Status: implementation-aware baseline for maintainer review; not a final production-security sign-off.

## Protected artifacts

- Wallet keystore credentials serialized from local wallet files.
- Backup slot payload checksums.
- Slot role metadata (`decoy`, `critical`).

## Threat actors

1. **Lost/stolen USB attacker** with filesystem read-only access.
2. **Local malware attacker** with user-level filesystem access.
3. **Integrity attacker** who tampers with backup file content.
4. **Operator error** causing stale, partial, or wrong-slot restore.

## Existing controls in implementation

- Argon2id key derivation with fixed defaults in wallet encryption path:
  - memory: `19,456 KiB`
  - iterations: `2`
  - parallelism: `1`
  - output length: `32`
- Authenticated encryption using `ChaCha20-Poly1305` via `EncryptedPayload`.
- Per-export payload checksum verification before restore writes.
- Role-scoped slot restore semantics (`decoy`/`critical`).

## Residual risks / out of scope

- No protection against a compromised endpoint capturing passphrases during entry.
- No hidden-volume deniability guarantees; decoy/critical roles are explicit metadata.
- No hardware-backed key assistance in current implementation.
- No remote backup transport controls in current implementation.

## Operator baseline recommendations

- Keep at least two offline backup media copies in distinct physical locations.
- Periodically run `wallet backup verify` and rehearse restore into an isolated environment.
- Rotate slot passphrases after any suspected endpoint compromise.
- Treat recovered wallet files as highly sensitive and immediately re-encrypt at rest.
