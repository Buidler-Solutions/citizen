# Wallet Browser Extension Encrypted Backup Runbook

## Purpose

This runbook explains **how to use encrypted backup in the Bahandi browser extension**.

It is implementation-aligned with:

- `citizen-protocol/docs/WALLET_ENCRYPTED_BACKUP_VAULT_IMPLEMENTATION_CHECKLIST.md`
- `wallet/browser/docs/WALLET_EXTENSION_BACKUP_SECURITY_BOUNDARIES.md`

Use this document when operators or support engineers need repeatable extension backup/recovery steps, plus CLI-equivalent commands for validation drills.

---

## Scope and Security Posture

This extension flow is designed for:

- creating decoy + critical encrypted backup material,
- exporting encrypted backup payloads for removable-media custody,
- verifying backup posture/reminders,
- restoring backup payloads with deterministic conflict handling.

This runbook does **not** claim stronger guarantees than the current implementation/tests. Keep recovery evidence and drill outcomes with your normal wallet support records.

---

## Preconditions

1. Wallet extension is installed and unlocked.
2. You have a mounted removable-media target for backup files.
3. Decoy and critical passphrases are different.
4. You understand conflict mode before restore:
   - **Replace existing IDs**: imported IDs overwrite matches.
   - **Keep existing IDs**: existing IDs stay; only missing IDs are added.

---

## Extension UI Workflow (Primary)

## 1) Open Backup Controls

1. Open the wallet extension popup.
2. Navigate to **Security**.
3. Open the encrypted backup section.

## 2) Create Backup Slots (Decoy + Critical)

1. Enter a decoy passphrase.
2. Enter a critical passphrase.
3. Confirm they are distinct and meet strength guidance.
4. Click **Create Backup Vault**.

Expected outcome:

- Extension initializes deterministic slot metadata locally.
- You see success feedback and backup status indicators.

## 3) Export Encrypted Backup Payload

1. Choose slot role (`decoy` or `critical`).
2. Select backup scope (keys, recovery metadata, consent artifacts as supported by the UI).
3. Click **Export Encrypted Backup**.
4. Save the produced encrypted payload to removable media.
5. Duplicate to a second removable medium for resilience.

Expected outcome:

- Exported artifact is encrypted payload data (no plaintext secret export to page context).

## 4) Verify Backup Posture

1. After export, use the **Mark Backup Verified** or equivalent reminder/verification action in the Security tab.
2. Record verification date in your operator logs.

Expected outcome:

- Extension updates backup freshness/posture tracking.

## 5) Restore Encrypted Backup Payload

1. In Security tab, choose **Restore Backup**.
2. Select the encrypted backup payload file.
3. Enter the slot passphrase.
4. Choose conflict mode:
   - Replace existing IDs, or
   - Keep existing IDs.
5. Confirm restore action.

Expected outcome:

- Extension decrypts in background worker,
- validates role/payload structure,
- applies selected deterministic conflict strategy,
- refreshes vault state.

---

## CLI-Equivalent Validation Commands (For Drill Parity)

When support teams need parity checks against the canonical CLI implementation, run these from `citizen-protocol/`.

> Note: These commands validate the backup lifecycle semantics and are useful for cross-surface runbook drills.

### Initialize backup vault

```bash
cargo run -p citizen-wallet --bin wallet -- backup init \
  --vault-path /media/$USER/CITIZEN_USB/citizen-extension-parity.vault \
  --decoy-passphrase 'decoy-passphrase-change-me' \
  --critical-passphrase 'critical-passphrase-change-me' \
  --json
```

### Export credentials to critical slot

```bash
cargo run -p citizen-wallet --bin wallet -- backup export-credentials \
  --wallet-path /tmp/citizen-wallet-test.json \
  --vault-path /media/$USER/CITIZEN_USB/citizen-extension-parity.vault \
  --slot critical \
  --passphrase 'critical-passphrase-change-me' \
  --include identity-keys \
  --include account-keys \
  --include recovery-metadata \
  --include consent-receipts \
  --json
```

### Verify vault artifact

```bash
cargo run -p citizen-wallet --bin wallet -- backup verify \
  --vault-path /media/$USER/CITIZEN_USB/citizen-extension-parity.vault \
  --slot critical \
  --passphrase 'critical-passphrase-change-me' \
  --json
```

### Restore into isolated wallet path

```bash
cargo run -p citizen-wallet --bin wallet -- backup restore \
  --vault-path /media/$USER/CITIZEN_USB/citizen-extension-parity.vault \
  --slot critical \
  --passphrase 'critical-passphrase-change-me' \
  --wallet-path /tmp/citizen-wallet-restored-from-extension-parity.json \
  --json
```

---

## Operational Hygiene Checklist

- Keep at least two removable-media copies.
- Store one copy offline in a separate physical location.
- Re-verify backup integrity on a periodic schedule.
- Always flush/safely eject removable media before unplugging.
- Rotate critical passphrases based on incident response or scheduled policy.

---

## Troubleshooting Quick Guide

- **Wrong passphrase / decrypt failure:** confirm slot role matches passphrase (decoy vs critical).
- **Restore conflicts:** re-run with the opposite conflict mode if the first strategy is not desired.
- **Stale backup indicator:** run a fresh export and mark verification completion.
- **Media write issues:** retry on a healthy/remounted removable device and confirm available space.

---

## Related References

- Implementation checklist: `citizen-protocol/docs/WALLET_ENCRYPTED_BACKUP_VAULT_IMPLEMENTATION_CHECKLIST.md`
- CLI operator runbook: `citizen-protocol/docs/WALLET_ENCRYPTED_BACKUP_VAULT_RUNBOOK.md`
- Disaster recovery: `citizen-protocol/docs/WALLET_BACKUP_DISASTER_RECOVERY_RUNBOOK.md`
- Extension security boundaries: `wallet/browser/docs/WALLET_EXTENSION_BACKUP_SECURITY_BOUNDARIES.md`
- Vault format/spec: `citizen-protocol/docs/WALLET_BACKUP_VAULT_FORMAT.md`
