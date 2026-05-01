# Vaultier

Vaultier is a dedicated portable backup vault app in this monorepo for Citizen wallet recovery flows.

## Status

This implementation advances the checklist in `citizen-protocol/docs/WALLET_ENCRYPTED_BACKUP_VAULT_IMPLEMENTATION_CHECKLIST.md` with a working UX scaffold:

- guided stage flow: `create -> verify -> restore -> eject`,
- decoy/critical slot setup in the create flow,
- portable profile card (USB label, version, created, last verified),
- deterministic operation log for operator review,
- mock vault-core adapter boundaries ready for Rust/Tauri integration.

## Package manager

Vaultier uses **pnpm**.

## Run locally

```bash
cd vaultier
pnpm install
pnpm dev
```

## Next implementation steps

- replace mock vault core with `citizen-protocol` wallet backup APIs,
- add removable drive discovery + deterministic error mapping,
- introduce crash-safe writes and safe-eject platform adapters,
- package signed portable desktop builds (Tauri target).
