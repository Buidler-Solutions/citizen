# Vaultier

Vaultier is a new portable backup vault application scaffold for Citizen wallet recovery workflows.

## Current status

This initial implementation starts the **Portable Application Track** from:
`citizen-protocol/docs/WALLET_ENCRYPTED_BACKUP_VAULT_IMPLEMENTATION_CHECKLIST.md`.

Implemented in this scaffold:
- dedicated `vaultier/` app folder in monorepo,
- sleek single-screen "Create Backup" UX with decoy/critical slot toggles,
- portable profile card and operation log,
- typed vault-core adapter boundary (`src/lib/types.ts`) for later Rust/Tauri integration.

## Run locally

```bash
cd vaultier
npm install
npm run dev
```

## Next steps

- replace mock vault core with `citizen-protocol` wallet backup APIs,
- add verify + restore flows,
- add removable drive detection and safe-eject guidance,
- package as Tauri desktop app for portable USB use.
