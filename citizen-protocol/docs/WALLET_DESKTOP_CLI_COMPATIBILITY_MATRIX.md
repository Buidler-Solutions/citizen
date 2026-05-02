# Wallet Desktop ↔ CLI Compatibility Matrix

## Purpose

Define the currently supported compatibility contract between Vaultier desktop flows (`wallet/desktop` + `vaultier`) and the canonical wallet CLI JSON contract (`citizen-wallet wallet backup ... --json`).

This matrix is implementation-state documentation for operator rehearsals and CI parity checks. It does **not** claim production desktop runtime readiness.

## Current Baseline (2026-05-02)

| Component | Version / contract | Status |
| --- | --- | --- |
| Wallet CLI JSON contract | `citizen.wallet.backup.cli.v1` | Canonical source of truth |
| Vault payload schema | `citizen.wallet.backup.v1` | Required for desktop + CLI parity |
| Vaultier WB-mode profile | `wb-simulation` | Default rehearsal/runtime profile |
| Vaultier Tauri runtime profile | `tauri-runtime` | Opt-in parity/hardening profile |

## Command Compatibility

| Operation | CLI command | WB-mode simulation | Tauri runtime bridge |
| --- | --- | --- | --- |
| Initialize vault | `wallet backup init --json` | Supported (fixture-gated) | Supported (shell-backed bridge; in-process pending) |
| Add slot | `wallet backup add-slot --json` | Supported (fixture-gated) | Supported (shell-backed bridge; in-process pending) |
| Export credentials | `wallet backup export-credentials --json` | Supported (fixture-gated) | Supported (shell-backed bridge; in-process pending) |
| Verify | `wallet backup verify --json` | Supported (fixture-gated) | Supported (shell-backed bridge; in-process pending) |
| Restore | `wallet backup restore --json` | Supported (fixture-gated) | Supported (shell-backed bridge; in-process pending) |
| Diagnostics | `wallet backup diagnostics --json` | Supported | Supported |

## Deterministic Compatibility Rules

1. Desktop responses must remain field-compatible with CLI v1 top-level keys.
2. Runtime adapters must preserve deterministic `error.code` mappings (including wrapped runtime failures mapped to CLI-equivalent error identifiers).
3. Redaction behavior for secret-like fields must match between WB-mode and runtime modes.
4. Desktop flow states must keep deterministic transitions used by rehearsal and CI: `preflight`, `writing`, `flushing`, `verify_required`, `completed`, `action_required`.

## Release Notes / Migration Expectations

- As long as CLI contract remains `citizen.wallet.backup.cli.v1`, desktop releases must preserve backward-compatible response key presence and deterministic error IDs.
- Any future CLI contract bump (`v2+`) requires:
  1. a migration note,
  2. updated fixture snapshots,
  3. updated runtime parity checks,
  4. checklist status refresh in `WALLET_ENCRYPTED_BACKUP_VAULT_IMPLEMENTATION_CHECKLIST.md`.

## Known Gaps Before Production Desktop Claims

- Replace shell-based Tauri bridge execution with in-process wallet-core bindings.
- Complete OS-native removable-media adapters with deterministic parity across Linux/macOS/Windows.
- Complete signed packaging/reproducible artifact pipeline.
- Finish memory/logging bridge audit sign-off.
