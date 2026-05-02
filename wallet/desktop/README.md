# Citizen Wallet Desktop (Vaultier Runtime Shell)

This package bootstraps the Tauri-first desktop runtime for Vaultier so portable backup flows can move from web-mock adapters to real runtime bridge commands.

## Scope

- Tauri shell scaffold with deterministic command IDs.
- Typed request/response DTOs for backup operations.
- Bridge handlers now invoke `citizen-wallet` CLI backup commands (`init`, `add-slot`, `export-credentials`, `verify`, `restore`) and return deterministic desktop contract envelopes while preserving implementation gaps for argument/secret plumbing.

## Commands

```bash
cd wallet/desktop
pnpm install
pnpm tauri:dev
# or build runtime explicitly
cargo check --manifest-path src-tauri/Cargo.toml --features desktop-runtime
```

## Notes

- The source-of-truth backup behavior remains `citizen-protocol/crates/wallet` and `vaultier/src/lib/runtimeBridge.ts`.
- This package is intentionally minimal so PR-E1 can land without blocking on full OS adapter implementation.

- Current bridge execution shells out to `cargo run -p citizen-wallet -- wallet backup ... --json` from `citizen-protocol/` and is intended as a cautious implementation step until native in-process wallet-core bindings land.

- Linux note: `desktop-runtime` intentionally gates Tauri/WebKitGTK dependencies so plain `cargo check --manifest-path src-tauri/Cargo.toml` can run without `javascriptcoregtk` system packages; runtime builds still require system WebKitGTK/JavascriptCore packages.
