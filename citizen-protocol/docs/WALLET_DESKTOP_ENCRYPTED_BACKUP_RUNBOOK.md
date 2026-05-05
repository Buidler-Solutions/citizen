# Wallet Desktop Encrypted Backup Runbook (Tauri / Vaultier)

## Purpose

This runbook explains how to use the desktop (Tauri-based) encrypted wallet backup flows using the same contract and command lifecycle defined in `WALLET_ENCRYPTED_BACKUP_VAULT_IMPLEMENTATION_CHECKLIST.md`.

It is the desktop companion to:

- `WALLET_ENCRYPTED_BACKUP_VAULT_RUNBOOK.md` (CLI primary runbook)
- `WALLET_DESKTOP_CLI_COMPATIBILITY_MATRIX.md` (desktop ↔ CLI contract mapping)
- `WALLET_BACKUP_DISASTER_RECOVERY_RUNBOOK.md` (broader recovery operations)

---

## Scope and Current Baseline

This document covers **operator usage** for desktop backup workflows that map to the canonical wallet backup lifecycle:

1. init vault
2. add slot
3. export credentials
4. verify
5. restore
6. flush writes + safe eject

Desktop behavior is required to stay compatible with `citizen.wallet.backup.cli.v1` response envelopes and deterministic error identifiers.

---

## Preconditions

1. Start from repo root:

```bash
cd /workspace/citizen
```

2. Confirm wallet backup CLI commands are available (desktop bridge maps to this lifecycle contract):

```bash
cd citizen-protocol
cargo run -p citizen-wallet --bin wallet -- backup --help
```

3. Use removable-media paths supported by desktop preflight checks:

- Linux: `/media/<user>/<label>/...` or `/mnt/...`
- macOS: `/Volumes/<label>/...`
- Windows: `X:\\...`

4. Prepare distinct passphrases:

- decoy passphrase
- critical passphrase
- (optional) archive passphrase

5. Keep the USB target local-only. Remote URLs and network share paths are intentionally rejected by desktop preflight.

---

## Running the Desktop App (Tauri)

From repository root:

```bash
cd wallet/desktop
pnpm install
pnpm tauri dev
```

Recommended runtime profile:

- Default rehearsal profile: `wb-simulation`
- Runtime parity/hardening profile: `tauri-runtime` (opt-in)

When validating removable-media and runtime command behavior, use `tauri-runtime` so the desktop bridge executes real backup command handlers.

---

## Desktop Workflow (Operator Steps)

## 1) Initialize backup vault (decoy + critical)

In the desktop backup screen:

- choose removable-media vault path,
- enter decoy + critical passphrases,
- run **Initialize Vault**,
- save JSON result artifact.

CLI-equivalent contract command:

```bash
cargo run -p citizen-wallet --bin wallet -- backup init --json
```

Expected outcome:

- vault file created,
- decoy and critical slots initialized,
- deterministic JSON envelope with success status.

## 2) Add optional archive slot

Desktop action:

- select existing vault,
- choose `archive` slot role,
- set archive passphrase,
- run **Add Slot**.

CLI-equivalent contract command:

```bash
cargo run -p citizen-wallet --bin wallet -- backup add-slot --json
```

## 3) Export credentials to slot

Desktop action:

- choose wallet path,
- choose vault path + slot (`critical` or `decoy`),
- choose export scopes (identity keys, account keys, recovery metadata, consent receipts),
- run **Export Credentials**.

CLI-equivalent contract command:

```bash
cargo run -p citizen-wallet --bin wallet -- backup export-credentials --json
```

Operational note: export to `critical` for high-impact recovery and keep decoy content role-appropriate.

## 4) Verify vault bundle

Desktop action:

- choose vault + slot,
- run **Verify Backup**.

CLI-equivalent contract command:

```bash
cargo run -p citizen-wallet --bin wallet -- backup verify --json
```

Desktop verify must enforce signed-manifest and integrity checks without bypass.

## 5) Restore into clean wallet path

Desktop action:

- select source vault + slot,
- set restore destination wallet path,
- choose conflict mode if prompted,
- run **Restore Backup**.

CLI-equivalent contract command:

```bash
cargo run -p citizen-wallet --bin wallet -- backup restore --json
```

Post-restore:

- verify identity continuity,
- re-run verify,
- execute key-rotation playbook from disaster recovery runbook as needed.

## 6) Flush writes + safe eject removable media

Desktop action order (required):

1. **Flush Vault Writes**
2. wait for successful flush completion
3. **Safe Eject Media**
4. physically remove media only after success or explicit manual fallback guidance

Desktop utility commands:

- `flush_vault_writes`
- `safe_eject_media`

If automatic eject is unavailable, follow desktop-provided OS-specific manual command guidance.

---

## Example End-to-End Drill (Desktop + Contract Evidence)

1. Initialize vault on USB.
2. Export to critical slot.
3. Verify.
4. Flush + safe eject.
5. Reconnect on second machine.
6. Verify again.
7. Restore to isolated wallet path.
8. Verify restored identity continuity.
9. Capture JSON outputs for each step into dated evidence files.

Use this cadence for periodic rehearsal and maintainer sign-off packets.

---

## Deterministic Error Handling Expectations

Desktop must surface stable, UI-safe identifiers for common failures, including:

- `path_invalid`
- `mount_unwritable`
- `insufficient_space`
- `media_unavailable`
- `flush_incomplete`
- `decrypt_failed`

Do not bypass failed preflight/verify/restore checks. Treat these as fail-closed conditions.

---

## Operator Safety Notes

- Keep decoy and critical passphrases distinct.
- Maintain duplicate removable-media copies and periodic re-verification cadence.
- Always flush/eject before unplug.
- Keep backup media offline when not actively used.
- This workflow does not eliminate malware/coercion/forensic-risk classes already defined in threat-model docs.

---

## Quick Command Map (Desktop Action → CLI Contract)

- Initialize Vault → `wallet backup init --json`
- Add Slot → `wallet backup add-slot --json`
- Export Credentials → `wallet backup export-credentials --json`
- Verify Backup → `wallet backup verify --json`
- Restore Backup → `wallet backup restore --json`
- Runtime diagnostics (if exposed) → `wallet backup diagnostics --json`

---

## Related Documents

- `WALLET_ENCRYPTED_BACKUP_VAULT_IMPLEMENTATION_CHECKLIST.md`
- `WALLET_ENCRYPTED_BACKUP_VAULT_RUNBOOK.md`
- `WALLET_DESKTOP_CLI_COMPATIBILITY_MATRIX.md`
- `WALLET_BACKUP_DISASTER_RECOVERY_RUNBOOK.md`
- `WALLET_ENCRYPTED_BACKUP_VAULT_THREAT_MODEL.md`
