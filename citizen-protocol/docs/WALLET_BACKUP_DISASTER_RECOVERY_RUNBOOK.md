# Wallet Backup Disaster Recovery Runbook

Status: ✅ Active runbook (v1)

This runbook defines the operator flow for recovering wallet credentials from the implemented
`wallet backup` vault lifecycle (`init`, `add-slot`, `export-credentials`, `verify`, `restore`) with
special handling for removable media and corrupted/partial backups.

Format + compatibility reference: `WALLET_BACKUP_VAULT_FORMAT.md` (v1 schema contract, forward-reject behavior, migration requirements).

## 1) Scope and assumptions

- Uses the current wallet CLI implementation in `citizen-protocol/crates/wallet`.
- Backup vault containers are user-custodied and encrypted.
- Restore candidate selection order is deterministic when multiple backups exist:
  `verified_at DESC`, then `created_at DESC`, then `id ASC`.

## 2) Required inputs

- Vault container path (`--vault-path`).
- Slot role (`decoy`, `critical`, or `archive` when enabled).
- Slot passphrase (interactive prompt or `WALLET_BACKUP_PASSPHRASE`).
- Target wallet output path for restore.

## 3) Standard recovery procedure

1. **Stage media safely**
   - Mount removable media read/write.
   - Do not unplug while any `wallet backup` command is active.

2. **Pre-restore integrity check**
   - Run:
     ```bash
     cargo run -p citizen-wallet -- wallet backup verify \
       --vault-path <vault.json> \
       --role <decoy|critical|archive> \
       --json
     ```
   - Require `status: ok` and no deterministic error code before restore.

3. **Restore credentials**
   - Run:
     ```bash
     cargo run -p citizen-wallet -- wallet backup restore \
       --vault-path <vault.json> \
       --role <decoy|critical|archive> \
       --out <wallet-restored.json> \
       --json
     ```

4. **Post-restore confirmation**
   - Re-run `wallet backup verify`.
   - Compare restored identity/account key fingerprints with known-good operator records.

5. **Safe eject discipline**
   - Wait for command completion and flush completion from host OS before unplugging media.

## 4) Corrupted or partial backup recovery

When `verify` or `restore` fails, use deterministic codes to guide response:

- `media_unavailable`: media disconnected; remount and retry from step 1.
- `invalid_payload` / `decrypt_failed`: treat slot as tampered, truncated, or wrong passphrase.
- `checksum_mismatch`: ciphertext or payload integrity failure.
- `slot_not_found`: requested role slot is absent.
- `unsupported_schema`: restore using compatible CLI/runtime version.

Recovery sequence:

1. Stop writes to affected media.
2. Re-run `wallet backup verify --json` and capture evidence output.
3. Attempt restore from next deterministic candidate vault by the documented ordering.
4. If no verified candidate succeeds, escalate to incident handling and key revocation path.

## 5) Key rotation guidance after restore

After any disaster restore (especially after corruption/tamper indicators):

1. Rotate restored wallet credentials as soon as service continuity is confirmed.
2. Re-issue dependent grants/authorizations tied to old keys.
3. Export fresh backup material into a new `critical` slot (or new vault container).
4. Verify the new backup immediately with `wallet backup verify`.
5. Retire superseded backup media using approved destruction/custody policy.

## 5.1) Slot lifecycle hygiene (wipe + passphrase rotation)

Use slot-scoped lifecycle commands to keep decoy/critical separation credible and to prevent stale
credentials from persisting in active media.

1. **Rotate slot passphrases on schedule and after elevated-risk events** (travel media exposure,
   host compromise suspicion, coercion drill execution):
   ```bash
   cargo run -p citizen-wallet -- wallet backup rotate-passphrase \
     --vault-path <vault.json> \
     --role <decoy|critical|archive> \
     --json
   ```
2. **Wipe slots before reuse or retirement**:
   ```bash
   cargo run -p citizen-wallet -- wallet backup wipe-slot \
     --vault-path <vault.json> \
     --role <decoy|critical|archive> \
     --json
   ```
3. Require successful role/passphrase authentication before either command; treat
   `decrypt_failed` or `slot_not_found` as hard-stop conditions that require operator review.
4. After rotation or wipe, run `wallet backup verify --json` and capture evidence output in the
   drill/recovery record.

## 6) Operator evidence checklist

Capture the following artifacts for each drill or production recovery:

- `verify` JSON output before restore.
- `restore` JSON output.
- `verify` JSON output after restore.
- Key rotation completion record (ticket/change id + timestamp).
- Media custody notes (device id, operator, handoff timestamp).

## 7) Duress-safe and deniability guidance (bounded, no false guarantees)

- Decoy and critical slots are separate encrypted envelopes, but plausible deniability is limited by operator behavior and forensic context.
- Under coercion/duress workflows, only present decoy material and avoid statements implying cryptographic proof that no additional slots exist.
- Keep decoy content realistic and periodically updated so restore drills do not create obviously stale decoy artifacts.
- Do not reuse decoy and critical passphrases; passphrase reuse weakens separation and makes coercion handling unsafe.
- Residual forensic risk remains (device metadata, host logs, shell history, removable-media access traces). Treat decoy mode as risk reduction, not guaranteed deniability.
