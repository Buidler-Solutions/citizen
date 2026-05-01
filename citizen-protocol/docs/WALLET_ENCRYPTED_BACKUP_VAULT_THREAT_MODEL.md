# Wallet Encrypted Backup Vault Threat Model (v1alpha1)

## Scope and status

This document covers the currently implemented wallet backup vault flow in `crates/wallet` CLI:

- `wallet backup init`
- `wallet backup add-slot`
- `wallet backup export-credentials`
- `wallet backup verify`
- `wallet backup restore`

Status: implementation-aware baseline for maintainer review; not a final production-security sign-off.

Format contract reference: `WALLET_BACKUP_VAULT_FORMAT.md` for stable `citizen.wallet.backup.v1` field and migration semantics.

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

## USB Safe-Eject + Write-Completion Checklist (PR-D2 closure)

Use this checklist whenever `wallet backup init`, `wallet backup export-credentials`, or `wallet backup restore` writes to removable media:

1. **Prepare media before writes**
   - Prefer journaled filesystems with broad cross-platform support (ex: exFAT for portability, APFS/NTFS/ext4 when environment-specific policies require them).
   - Ensure at least 2x expected vault size as free space to avoid partial-write failures during temp-file and metadata updates.
2. **During write operations**
   - Do **not** unplug the USB device while the CLI command is still running.
   - Treat CLI completion as the minimum flush signal; if your shell returns before terminal multiplexer buffers settle, wait for prompt repaint before device interaction.
3. **After command completion**
   - Run `wallet backup verify --vault-path <path> --role <decoy|critical>` before unplugging when operationally possible.
   - Use OS-level safe-eject/unmount controls so pending filesystem metadata writes are committed before removal.
4. **Operational hygiene**
   - Keep a duplicate encrypted backup on separate removable media in a different physical location.
   - Re-run verify checks on both copies at a fixed cadence (recommended: every 30 days).

Failure to follow safe-eject procedures can produce deterministic corruption errors such as `invalid_payload`, `decrypt_failed`, or `checksum_mismatch` during future restores.
