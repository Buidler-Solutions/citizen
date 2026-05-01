# Vaultier

Vaultier is a dedicated portable backup vault app in this monorepo for Citizen wallet recovery flows.

## Status

This implementation advances the checklist in `citizen-protocol/docs/WALLET_ENCRYPTED_BACKUP_VAULT_IMPLEMENTATION_CHECKLIST.md` with a working UX scaffold:

- guided stage flow: `create -> verify -> restore -> eject`,
- decoy/critical slot setup in the create flow,
- passphrase entropy guidance for decoy and critical roles,
- verify + restore guidance with deterministic checks and restore summaries,
- simulated wrong-passphrase unlock backoff behavior,
- optional restore-stage unlock backoff toggle aligned to CLI throttling semantics, with deterministic delay schedule,
- detected removable drive picker with macOS/Linux/Windows-style mount path examples,
- filesystem advisory on detected removable media (recommended vs higher-risk formats),
- safe-removal checklist with an explicit `flush pending writes` action,
- portable profile card (USB label, version, created, last verified),
- persisted verification reminder policy with next-check timestamp + due-state warning,
- deterministic operation log and mock diagnostic export bundle,
- diagnostic bundle now captures deterministic recent error identifiers (non-secret),
- mock vault-core adapter boundaries ready for Rust/Tauri integration.
- explicit runtime-shell signal (`web-mock` now, `tauri` target) for deterministic bridge behavior.
- crash-safe write strategy trace (temp write, fsync, atomic rename, parent fsync) surfaced in safe-removal flow.
- headless command adapter for init/verify/restore parity with CLI-style JSON responses.
- deterministic headless contract/version metadata + error taxonomy (`contractVersion=2026-05-01`) for backup init/verify/restore automation.

## Package manager

Vaultier uses **pnpm**.

## Run locally

```bash
cd vaultier
pnpm install
pnpm start  # alias for dev
```

## Direction update

The near-term direction is to keep Vaultier implementation-first and portable-ops focused:

1. Replace mock adapters with `citizen-protocol` wallet backup APIs.
2. Implement real removable-drive discovery and deterministic error mapping per OS.
3. Add crash-safe write strategy (temp file + fsync + atomic rename) in the desktop bridge.
4. Add safe-eject adapters for macOS, Windows, and Linux.
5. Package signed portable desktop builds (Tauri target).
