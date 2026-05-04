# TV3 Portable Smoke Evidence Template (2026-05-04T08:36:23.849Z)

Schema: `citizen.wallet.desktop.tv3.portable-smoke-evidence.v1`

Use this template to attach the first signed cross-platform smoke evidence snapshots referenced by the portable-track checklist.

## Evidence Summary

### Linux
- Latest smoke suite JSON: `TV3_PORTABLE_SMOKE_SUITE_2026-05-04T08-26-04.949Z.json`
- Generated at: 2026-05-04T08:26:04.950Z
- Summary status: pass
- Immutable release artifact URI: UNSET
- Reviewer sign-off (name/date): UNSET
- Command checks:
- wb_mode_contract_gate: pass (command: `pnpm test:headless-contract`)
- wallet_backup_regressions: pass (command: `cargo test --manifest-path /home/green/citizen/citizen-protocol/Cargo.toml -p citizen-wallet wallet_backup`)

### macOS
- Latest smoke suite JSON: `UNSET`
- Generated at: UNSET
- Summary status: UNSET
- Immutable release artifact URI: UNSET
- Reviewer sign-off (name/date): UNSET
- Command checks:
- UNSET: attach the latest smoke suite JSON for this host.

### Windows
- Latest smoke suite JSON: `UNSET`
- Generated at: UNSET
- Summary status: UNSET
- Immutable release artifact URI: UNSET
- Reviewer sign-off (name/date): UNSET
- Command checks:
- UNSET: attach the latest smoke suite JSON for this host.

## Checklist Cross-Links

- Portable Application Track exit criteria smoke gate reference: citizen-protocol/docs/WALLET_ENCRYPTED_BACKUP_VAULT_IMPLEMENTATION_CHECKLIST.md
- R9-D release checklist sign-off packet: UNSET
- Consolidated maintainer sign-off URI: UNSET
