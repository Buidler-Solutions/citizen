# Citizen Wallet Desktop (Vaultier Runtime Shell)

This package bootstraps the Tauri-first desktop runtime for Vaultier so portable backup flows can move from web-mock adapters to real runtime bridge commands.

## Scope

- Tauri shell scaffold with deterministic command IDs.
- Typed request/response DTOs for backup operations.
- Placeholder bridge handlers returning deterministic `not_implemented` until wallet-core wiring lands.

## Commands

```bash
cd wallet/desktop
pnpm install
pnpm tauri:dev
```

## Notes

- The source-of-truth backup behavior remains `citizen-protocol/crates/wallet` and `vaultier/src/lib/runtimeBridge.ts`.
- This package is intentionally minimal so PR-E1 can land without blocking on full OS adapter implementation.
