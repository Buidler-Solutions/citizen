# Wallet Desktop Beta Promotion Thresholds

## Purpose

Define deterministic **go/no-go** gates for enabling opt-in beta after alpha rehearsal.

## Go/No-Go Thresholds

All thresholds below are mandatory:

1. **Per-OS drill completion:** at least 1 fully passing alpha drill packet each for Linux, macOS, and Windows from the current cycle.
2. **Removable-media parity reliability:** at least 95% pass rate for create/add-slot/export/verify/restore/flush/eject sequence checks across submitted packets.
3. **Redaction safety:** zero unresolved regressions where secret-like fields appear in runtime/UI logs, diagnostics bundles, or crash artifacts.
4. **Security blockers:** zero open critical/high findings tied to bridge execution, packaging integrity, or recovery correctness.

If any threshold fails, beta promotion is automatically `no-go`.

## Escalation + Rollback Routing

- **Wallet correctness failures** -> Wallet owner leads triage and blocks beta flag changes.
- **Desktop/runtime bridge failures** -> Desktop/runtime owner leads rollback to WB-mode-only exposure.
- **Security/redaction/audit failures** -> Security owner issues immediate promotion hold and incident response handoff.

## Deterministic Rollback Expectations

When a threshold fails after beta opt-in has been enabled:

1. Disable beta opt-in flag for desktop runtime bridge features.
2. Revert to WB-mode rehearsal defaults for affected surfaces.
3. Publish incident status update with owner, scope, and recovery ETA.
4. Require fresh R9-E validation packet set before re-opening promotion vote.

## Required References

- `WALLET_DESKTOP_ALPHA_DRILL_SCHEDULE.md`
- `WALLET_DESKTOP_BRIDGE_INCIDENT_RESPONSE.md`
- `WALLET_DESKTOP_BETA_PROMOTION_MEMO_TEMPLATE.md`
