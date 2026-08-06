# Wallet

This directory contains the wallet application surfaces that sit on top of the shared Rust wallet core (`crates/wallet`). The mobile and browser extension surfaces are branded as **Bahandi**.

## Applications

- `cli/` — standalone command-line wallet client for operators/builders.
- `react/` — broader web wallet console for onboarding, key management, namespace operations, receipts, and governance UX.
- `browser/` — **Bahandi** — focused signer-keeper browser extension for popup request review and explicit sign/reject flows.
- `mobile/` — **Bahandi** — Flutter-based mobile wallet (iOS + Android) with WalletConnect dApp integration, transaction signing, hybrid decryption, vault management, and direct submit.
- `desktop/` — Tauri-based desktop wallet with Rust bridge for backup vault operations.
- `backup-vault/` — backup vault schema and tooling for encrypted wallet export/import.
- `backend/` — lightweight wallet-auth backend for challenge/verify login APIs used by dApps.
- `sdk/typescript-auth/` — reusable TypeScript SDK for browser wallet login (`challenge`/`verify`) usable by onboarding sites and dApps.

## Implementation Status

All wallet surfaces are implemented and actively used in local-stack validation workflows.

Delivered baseline:

- wallet core provides key custody, signing/verification, policy controls, and provider abstraction hooks,
- CLI supports key lifecycle, namespace signing helpers, submission, deterministic receipt validation, and builder-credit multisig proof workflows,
- React console provides onboarding, operation builders, and receipt/governance UX,
- browser extension provides dedicated in-browser signing interactions,
- mobile wallet provides native iOS/Android wallet UX with WalletConnect dApp pairing, 7-tab interface (Activity, Connect, Decrypt, Compose, Vault, Security, Profile), secure key storage via platform keychain/keystore, BIP39 mnemonic generation (12/24 word), mandatory backup flow, and direct submit to Citizen nodes,
- desktop wallet provides Tauri-based desktop wallet with Rust bridge for backup vault operations,
- all surfaces share the same crypto derivation path (BIP39 → SLIP-0010 `m/44'/930'/0'/0'/0'` → Ed25519 signer + X25519 reader) ensuring cross-platform key compatibility,
- wallet-facing app stacks should mirror namespace `offchain_encrypted_file_policy.allowed_mime_types`
  when validating encrypted file attachments (audio/video/docs/sheets/images) before submit.

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
