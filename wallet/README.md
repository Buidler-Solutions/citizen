# Citizen Wallet

This directory contains the wallet application surfaces that sit on top of the shared Rust wallet core (`crates/wallet`).

## Applications

- `cli/` — standalone command-line wallet client for operators/builders.
- `react/` — broader web wallet console for onboarding, key management, namespace operations, receipts, and governance UX.
- `browser/` — focused signer-keeper browser extension for popup request review and explicit sign/reject flows.
- `backend/` — lightweight wallet-auth backend for challenge/verify login APIs used by dApps.

## Implementation Status

All three wallet surfaces are implemented and actively used in local-stack validation workflows.

Delivered baseline:

- wallet core provides key custody, signing/verification, policy controls, and provider abstraction hooks,
- CLI supports key lifecycle, namespace signing helpers, submission, deterministic receipt validation, and builder-credit multisig proof workflows,
- React console provides onboarding, operation builders, and receipt/governance UX,
- browser extension provides dedicated in-browser signing interactions.

## Key Documentation

- `docs/WALLET_IMPLEMENTATION_TASKS.md`
- `docs/WALLET_TASK_STATUS_REVIEW.md`
- `docs/WALLET_READINESS_REVIEW.md`
- `docs/WALLET_SECURITY_REVIEW.md`
- `docs/WALLET_DECISIONS.md`
- `docs/WALLET_DAPP_AUTH_DEVELOPER_GUIDE.md`

## Validation Entrypoints

- CLI smoke: `scripts/run_wallet_cli_e2e.sh`
- Wallet/explorer parity checks: `scripts/run_builder_asset_parity_checks.sh`
- Full stack runbook: `docs/STACK_TESTING_GUIDE.md`
