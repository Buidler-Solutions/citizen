# Wallet Desktop Alpha Drill Schedule (Checkpoint 9 / R9-B)

## Cadence
- Run cadence: 3 times per week during alpha (Mon/Wed/Fri).
- Required environments each week: Linux, macOS, Windows (at least one successful full drill per OS).
- Promotion precondition: two consecutive weeks with no blocker-class failures.

## Drill Sequence (Deterministic Order)
1. `init` (decoy + critical)
2. `add-slot` (archive or role-extension scenario)
3. `export-credentials`
4. `verify`
5. `restore`
6. `flush`
7. `safe-eject`

## Pass/Fail Rules
- Pass requires all 7 steps completing with deterministic contract outputs.
- Any redaction, tamper-detection mismatch, or removable-media gate bypass is an automatic fail.
- Runtime parity failures between WB-mode and Tauri-runtime require same-day triage owner assignment.

## Weekly Ownership Rotation
- Week owner roles:
  - Wallet maintainer on-call
  - Desktop maintainer on-call
  - Security maintainer reviewer

## Evidence Requirements
- Every drill run must produce:
  - command log excerpt,
  - profile mode used,
  - OS + filesystem details,
  - result status per step,
  - incident notes (if any).
- Store records using the packet template:
  - `citizen-protocol/docs/evidence/wallet-backup-vault/WALLET_BACKUP_ALPHA_DRILL_PACKET_TEMPLATE.md`
