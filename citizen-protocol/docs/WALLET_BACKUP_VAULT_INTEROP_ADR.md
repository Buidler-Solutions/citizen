# ADR: Wallet Backup Vault Interop Contract Versioning and Package Layout

- **Status:** Accepted
- **Date:** 2026-05-03
- **Owners:** wallet + desktop maintainers
- **Related checklist:** `WALLET_ENCRYPTED_BACKUP_VAULT_IMPLEMENTATION_CHECKLIST.md` Checkpoint 1

## Context

The wallet backup vault implementation already ships in:

- `citizen-protocol/crates/wallet` (vault model, encryption, and CLI commands),
- `wallet/desktop/src-tauri` (desktop bridge command handlers),
- `vaultier` (desktop UI runtime bridge).

Checkpoint 1 requires a complete architecture and interop decision, including an explicit versioning plan for CLI and desktop/extension clients.

## Decision

1. **Authoritative implementation stays inside the protocol workspace** under `citizen-protocol/crates/wallet` with CLI adapters.
2. **Shared interop schema is versioned at two layers:**
   - CLI automation contract: `citizen.wallet.backup.cli.v1`.
   - Desktop bridge wrapper contract: `citizen.wallet.backup.desktop.v1alpha1`.
3. **Desktop bridge MUST fail-closed on contract mismatch** before processing payloads.
4. **Extension/web surfaces align to the CLI `v1` envelope semantics** (`status`, `contract_version`, deterministic `error_id`) and can use their own transport wrapper version while preserving the CLI schema body.
5. **`wallet/backup-vault` extraction is deferred** until there is clear evidence of cross-runtime coupling pressure that cannot be handled with current module boundaries.

## Why this decision

- Keeps governance-first wallet behavior anchored to the implemented Rust wallet crate.
- Preserves deterministic JSON contracts required by operator automation and runbooks.
- Allows desktop/extension transports to evolve without breaking the stable CLI automation payload.
- Avoids premature package fragmentation.

## Contract boundaries

### Stable now

- `citizen.wallet.backup.cli.v1` is the **stable public automation interface** for backup init/verify/restore flows.
- Deterministic `error_id` taxonomy remains part of the compatibility promise for `v1`.

### Forward migration notes

- Next breaking CLI schema revision increments major (`v2`) and requires:
  - dual-write or translation period documented in release notes,
  - updated fixtures + compatibility tests,
  - runbook and docs example refresh.
- Desktop wrapper progresses from `v1alpha1` → `v1` only after:
  - in-process wallet-core bridge closure,
  - extension contract convergence evidence,
  - cross-platform parity validation.
- During `v1alpha1`, additive fields are allowed; removals/renames are not.

## Consequences

- **Positive:** clear source of truth, deterministic automation behavior, and explicit migration path.
- **Tradeoff:** desktop wrapper remains pre-stable while transport hardening is still in progress.
- **Deferred:** independent `wallet/backup-vault` package extraction remains an explicit future option, not a current requirement.
