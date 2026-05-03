# Wallet Desktop Bridge Rollback and Incident Response (Pre-Beta)

## Purpose

Define deterministic rollback and escalation triggers for Vaultier desktop bridge regressions before beta promotion.

## Trigger Classes

### 1) Contract Drift Trigger

Raise incident when any of the following occurs:

- Runtime adapter output no longer matches required `citizen.wallet.backup.cli.v1` envelope keys.
- Required command parity snapshot check fails for `init`, `add-slot`, `export-credentials`, `verify`, `restore`.
- Error-code mapping diverges from deterministic CLI contract (`error.code`).

Severity:

- High if drift affects restore/verify.
- Medium for diagnostics-only drift.

Immediate action:

- Force profile default to `wb-simulation`.
- Block runtime adapter pathways behind explicit maintainer override.

### 2) Removable-Media Safety Trigger

Raise incident when:

- Flush strategy reports incomplete required durability steps.
- Safe-eject path fails without deterministic fallback guidance.
- Media availability checks regress (false-positive writable/ready state).

Severity:

- High for any data-loss risk.

Immediate action:

- Disable guided success completion for affected command path.
- Surface `action_required` status with deterministic manual operator steps.

### 3) Redaction / Secret-Exposure Trigger

Raise incident when:

- Secret-like fields appear in logs, telemetry, diagnostics, or bridge error payloads.
- Redaction guard tests fail in CI or alpha drill evidence.

Severity:

- Critical.

Immediate action:

- Halt alpha rollout progression.
- Revoke new desktop alpha build publication until fix + audit rerun completes.

## Rollback Procedure

1. Record incident in alpha evidence packet with timestamp, command path, and deterministic error code(s).
2. Switch execution profile default to `wb-simulation` for next build.
3. Re-run contract gate + headless parity checks.
4. Re-run removable-media drill on at least one Linux/macOS/Windows rehearsal environment (if applicable to incident class).
5. Require wallet + crypto + desktop maintainer sign-off before runtime mode is re-enabled.

## Owner Handoff Matrix

- **Desktop runtime maintainer**: triage bridge/runtime defects and prepare patch.
- **Wallet maintainer**: validate contract/error taxonomy compatibility.
- **Crypto/security maintainer**: review any redaction or secret-exposure risk.
- **Release owner**: enforce rollout gate outcomes and release-note risk disclosure.

## Promotion Gate Impact

Any open High/Critical trigger blocks:

- transition from Phase 1 alpha to Phase 2 beta,
- claims of production-ready desktop bridge behavior,
- runtime profile defaulting beyond WB-mode rehearsal.
