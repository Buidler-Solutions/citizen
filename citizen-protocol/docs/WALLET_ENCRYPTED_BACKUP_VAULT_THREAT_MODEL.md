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

## Protected artifacts (Checkpoint 0 inventory)

The backup inventory is role-scoped (`decoy` vs `critical`) and source-scoped (CLI, desktop/Tauri bridge rehearsal path, extension runtime path).

### Credential artifacts requiring backup

1. **`keys` export scope (implemented CLI scope)**
   - wallet keystore material exported via `wallet backup export-credentials --scopes keys` (the default scope in CLI).
2. **`recovery-metadata` export scope (implemented CLI scope)**
   - deterministic recovery metadata emitted by `--scopes recovery-metadata`, including continuity hints required for ordered restore operations.
3. **`consent-receipts` export scope (implemented CLI scope)**
   - consent receipt artifacts exported when `--scopes consent-receipts` is included.
4. **Vault continuity and integrity metadata**
   - backup manifest (`manifest.json`) and signed manifest (`manifest.sig`), schema/version markers, slot role metadata, deterministic checksums/hashes, and verification timestamps.
5. **Portable rehearsal metadata (desktop/Vaultier, non-secret)**
   - non-secret portable profile metadata (`portable_label`, `created_at`, `last_verified_at`, `schema_version`) used to drive deterministic operator workflows.

### Explicitly excluded from backup payloads

- Plaintext passphrases.
- Raw secret fields in command/bridge logs.
- Browser page-context plaintext secret exfiltration.

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


## Security + usability success criteria (Checkpoint 0 thresholds)

The following thresholds are used to close Checkpoint 0 requirement definition and to gate desktop/Tauri continuation work:

- **Deterministic contract safety**: `wallet backup init|verify|restore --json` and desktop bridge envelopes MUST include `contract_version=citizen.wallet.backup.cli.v1` with deterministic `error_id` mapping for failures.
- **Integrity enforcement**: verify/restore paths MUST fail closed when signed manifest artifacts are missing or invalid (`manifest_missing`, signature/hash mismatch classes).
- **Tamper detection**: malformed/truncated/bit-flipped vault payload tests MUST deterministically fail with non-success status and stable error taxonomy.
- **Removable-media hygiene UX**: create/export/restore flows MUST present explicit unplug-during-write risk warnings and flush/safe-eject guidance before completion.
- **Performance envelope (operator UX)**: balanced profile targets for workstation-class hardware SHOULD remain within current enforced thresholds used by regression checks (export/verify/restore latency checks emitted in JSON `performance` fields).
- **Recovery usability**: multi-backup restore ordering MUST be deterministic (`verified_at DESC`, `created_at DESC`, `id ASC`) and documented in runbook guidance.
- **Secret minimization**: bridge responses/logs MUST redact passphrase/secret-like fields and reject payloads containing sensitive keys in response objects.

These criteria define requirement-complete status for Checkpoint 0; maintainer acceptance/sign-off remains tracked separately in the implementation checklist.
