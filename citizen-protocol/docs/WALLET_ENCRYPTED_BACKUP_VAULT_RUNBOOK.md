# Wallet Encrypted Backup Vault Runbook (CLI + Operator)

## Purpose

This runbook is the operator-facing "how to use it" companion for the implementation checklist in `WALLET_ENCRYPTED_BACKUP_VAULT_IMPLEMENTATION_CHECKLIST.md`.

Use this document when you need repeatable wallet backup vault commands for:

- initializing a multi-slot vault,
- exporting wallet credentials into encrypted slots,
- verifying integrity/tamper checks,
- restoring into a clean wallet path,
- rotating passphrases and wiping slots.

The guidance here is implementation-first and matches the current `citizen-wallet` CLI behavior.

---

## Preconditions

1. Work from the protocol workspace:

```bash
cd citizen-protocol
```

2. Make sure a wallet keystore already exists (for example from `wallet keygen`) and set wallet password environment for commands that require unlock.

```bash
export CITIZEN_WALLET_PASSWORD='${CITIZEN_WALLET_PASSWORD:?set your wallet passphrase}'
```

3. Use a removable-media target path for custody workflows:

- Linux: `/media/<user>/<label>/...` or `/mnt/...`
- macOS: `/Volumes/<label>/...`
- Windows: `X:\\...`

4. Keep decoy and critical passphrases distinct.

---

## Command Reference (Primary Lifecycle)

### 1) Initialize the vault (decoy + critical)

```bash
cargo run -p citizen-wallet --bin wallet -- backup init \
  --vault-path /media/$USER/CITIZEN_USB/citizen-backup.vault \
  --decoy-passphrase 'decoy-passphrase-change-me' \
  --critical-passphrase 'critical-passphrase-change-me' \
  --json
```

What it does:

- creates the encrypted vault container,
- initializes decoy + critical slots,
- emits deterministic JSON output for automation.

### 2) (Optional) Add an archive slot

```bash
cargo run -p citizen-wallet --bin wallet -- backup add-slot \
  --vault-path /media/$USER/CITIZEN_USB/citizen-backup.vault \
  --slot archive \
  --passphrase 'archive-passphrase-change-me' \
  --json
```

Use archive slots for lower-frequency retention copies while keeping decoy/critical operational paths separate.

### 3) Export encrypted credentials into a slot

```bash
cargo run -p citizen-wallet --bin wallet -- backup export-credentials \
  --wallet-path /tmp/citizen-wallet-test.json \
  --vault-path /media/$USER/CITIZEN_USB/citizen-backup.vault \
  --slot critical \
  --passphrase 'critical-passphrase-change-me' \
  --include identity-keys \
  --include account-keys \
  --include recovery-metadata \
  --include consent-receipts \
  --json
```

Repeat with `--slot decoy` and decoy-safe material for bounded deniability workflows.

### 4) Verify vault integrity and signed manifest checks

```bash
cargo run -p citizen-wallet --bin wallet -- backup verify \
  --vault-path /media/$USER/CITIZEN_USB/citizen-backup.vault \
  --slot critical \
  --passphrase 'critical-passphrase-change-me' \
  --json
```

Run verify immediately after export and during periodic drills.

### 5) Restore from vault into a clean wallet path

```bash
cargo run -p citizen-wallet --bin wallet -- backup restore \
  --vault-path /media/$USER/CITIZEN_USB/citizen-backup.vault \
  --slot critical \
  --passphrase 'critical-passphrase-change-me' \
  --wallet-path /tmp/citizen-wallet-restored.json \
  --json
```

Post-restore actions:

- verify identity continuity,
- re-run `backup verify`,
- follow key rotation playbook as needed.

---

## Slot Maintenance Commands

### Rotate slot passphrase

```bash
cargo run -p citizen-wallet --bin wallet -- backup rotate-passphrase \
  --vault-path /media/$USER/CITIZEN_USB/citizen-backup.vault \
  --slot critical \
  --current-passphrase 'critical-passphrase-change-me' \
  --new-passphrase 'critical-passphrase-rotated-change-me' \
  --json
```

### Wipe slot content (role metadata retained)

```bash
cargo run -p citizen-wallet --bin wallet -- backup wipe-slot \
  --vault-path /media/$USER/CITIZEN_USB/citizen-backup.vault \
  --slot archive \
  --passphrase 'archive-passphrase-change-me' \
  --json
```

After rotation or wipe, run `backup verify` again and store JSON evidence.

---

## Recommended Operator Sequence

1. Initialize vault on removable media.
2. Export credentials to critical slot.
3. Verify immediately.
4. Duplicate the vault file to second removable medium.
5. Safely flush/eject media before physical removal.
6. Run periodic integrity re-verification.
7. Execute scheduled restore drills into isolated test paths.

---

## Automation Tips

- Prefer `--json` for deterministic parsing.
- Capture command outputs into dated evidence logs.
- Use explicit absolute paths in automation scripts.
- Fail closed on verify/restore errors; do not bypass manifest checks.

---

## What This Runbook Does Not Change

- It does not claim production security beyond documented maintainer sign-off artifacts.
- It does not replace threat-model review (`WALLET_ENCRYPTED_BACKUP_VAULT_THREAT_MODEL.md`).
- It does not change canonical schema/version behavior (`WALLET_BACKUP_VAULT_FORMAT.md`).

For broader recovery operations and incident handling, use `WALLET_BACKUP_DISASTER_RECOVERY_RUNBOOK.md`.
