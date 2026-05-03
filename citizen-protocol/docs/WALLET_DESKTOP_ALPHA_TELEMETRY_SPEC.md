# Wallet Desktop Alpha Telemetry Specification (Privacy-Preserving, Local-Only)

## Scope

Define the pre-beta telemetry contract for Vaultier desktop alpha drills so maintainers can evaluate backup reliability without collecting secret-bearing data.

This specification is constrained to:

- local-only counters/log markers written to operator-controlled local storage,
- no network transmission by default,
- deterministic field-level redaction requirements aligned with `citizen.wallet.backup.cli.v1`.

## Data Handling Rules

- No plaintext wallet credentials, passphrases, ciphertext payload bytes, or manifest signature material may be persisted in telemetry fields.
- Telemetry records must use bounded enums, booleans, counters, and coarse timing buckets.
- Any field that can include command arguments or free-form stderr/stdout must be sanitized through existing redaction helpers before persistence.
- Export of telemetry artifacts is opt-in and must route through the existing diagnostics bundle path.

## Local Event Contract (v1alpha1)

Each event uses the envelope:

- `schema`: `citizen.wallet.desktop.telemetry.v1alpha1`
- `captured_at`: RFC3339 UTC timestamp
- `profile`: `wb-simulation` | `tauri-runtime`
- `command`: `backup_init` | `backup_add_slot` | `backup_export_credentials` | `backup_verify` | `backup_restore` | `backup_diagnostics` | `flush_vault_writes` | `safe_eject_media`
- `result`: `success` | `failure`
- `error_code`: deterministic machine code only (nullable)
- `duration_bucket`: `<1s` | `1-3s` | `3-10s` | `10-30s` | `>30s`
- `confidence_marker`: `verified_recently` | `restore_rehearsed` | `eject_confirmed` | `action_required`

## Required Local Counters

Maintain rolling counters (resettable by operator):

- `backup.create.success_total`
- `backup.create.failure_total`
- `backup.verify.success_total`
- `backup.verify.failure_total`
- `backup.restore.success_total`
- `backup.restore.failure_total`
- `backup.flush.success_total`
- `backup.flush.failure_total`
- `backup.eject.success_total`
- `backup.eject.failure_total`
- `backup.redaction_guard.failure_total`
- `backup.contract_parity.failure_total`

## Confidence Markers for Promotion Decisions

The following markers are required in alpha evidence packets before beta recommendation:

1. At least one successful create/export/verify/restore sequence per OS rehearsal environment.
2. At least one successful flush + safe-eject completion per rehearsal environment.
3. Zero unresolved redaction guard failures.
4. Zero unresolved contract parity failures between WB-mode and runtime bridge checks.

## Storage and Retention

- Default retention window: 30 days local rolling window.
- Operator may purge all telemetry from the app settings path.
- Diagnostic exports must include a `telemetry_redaction_verified: true|false` field.

## Non-Goals

- No user analytics, behavioral profiling, or remote usage tracking.
- No per-identity correlation identifiers.
- No transmission to protocol services.
