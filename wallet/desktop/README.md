# Citizen Wallet Desktop (Vaultier Runtime Shell)

This package bootstraps the Tauri-first desktop runtime for Vaultier so portable backup flows can move from web-mock adapters to real runtime bridge commands.

## Scope

- Tauri shell scaffold with deterministic command IDs.
- Typed request/response DTOs for backup operations.
- Bridge handlers invoke `citizen-wallet` CLI backup commands (`init`, `add-slot`, `export-credentials`, `verify`, `restore`), accept typed `payload.args` to forward command arguments, and return deterministic desktop contract envelopes while preserving implementation gaps for in-process wallet-core bindings.

## Commands

```bash
cd wallet/desktop
pnpm install
pnpm doctor:linux # Linux only: verifies javascriptcoregtk/webkit2gtk pkg-config deps
pnpm doctor:linux:fix # Linux only: attempts distro-aware package installation
pnpm tauri:dev
# or build runtime explicitly
cargo check --manifest-path src-tauri/Cargo.toml --features desktop-runtime
```

## Notes

- The source-of-truth backup behavior remains `citizen-protocol/crates/wallet` and `vaultier/src/lib/runtimeBridge.ts`.
- This package is intentionally minimal so PR-E1 can land without blocking on full OS adapter implementation.

- Current bridge execution shells out to `cargo run -p citizen-wallet -- wallet backup ... --json` from `citizen-protocol/` and is intended as a cautious implementation step until native in-process wallet-core bindings land.

- Linux note: `desktop-runtime` intentionally gates Tauri/WebKitGTK dependencies so plain `cargo check --manifest-path src-tauri/Cargo.toml` can run without `javascriptcoregtk` system packages; runtime builds still require system WebKitGTK/JavascriptCore packages.

### Linux dependency fix for `javascriptcore-rs-sys` build errors

If `pnpm tauri:dev` fails with:

- `Package javascriptcoregtk-4.1 was not found in the pkg-config search path`
- `The system library javascriptcoregtk-4.1 required by crate javascriptcore-rs-sys was not found`

install native development packages and rerun the doctor script:

```bash
# Ubuntu/Debian
sudo apt-get update && sudo apt-get install -y libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev

# Fedora
sudo dnf install webkit2gtk4.1-devel javascriptcoregtk4.1-devel

# Arch
sudo pacman -S webkit2gtk-4.1

cd wallet/desktop
pnpm doctor:linux
# optional automated install path (requires sudo)
pnpm doctor:linux:fix
pnpm tauri:dev
```

If packages are installed but detection still fails, check whether `pkg-config` can see `.pc` files:

```bash
pkg-config --modversion javascriptcoregtk-4.1
pkg-config --modversion webkit2gtk-4.1
```

If those commands fail, export `PKG_CONFIG_PATH` to the directory that contains the `.pc` files (the `pnpm doctor:linux` script now prints candidate paths when it detects this situation).

## Implementation Status

- Desktop app is implemented as a runnable Vaultier desktop surface (`wallet/desktop` + `vaultier`).
- Current bridge strategy is intentionally cautious: runtime commands delegate to wallet CLI JSON contracts until in-process wallet-core bindings are finalized.
- Not yet production-complete: packaging/signing, full OS-native removable-media adapters, and bridge hardening audits are still tracked in the checklist at `citizen-protocol/docs/WALLET_ENCRYPTED_BACKUP_VAULT_IMPLEMENTATION_CHECKLIST.md`.

## Known Limitations (Current Desktop Rehearsal Build)

- **Unsigned local/dev builds:** local Tauri builds are intended for rehearsal and CI parity work, not trust-on-first-use production distribution. Signed/reproducible release artifacts are still pending checklist closure.
- **WB-mode and bridge boundaries:** Vaultier WB-mode remains the default rehearsal profile; runtime bridge parity is still converging and CLI-shell fallback is still present for several operations.
- **Removable-media emulation caveat:** automated tests and local drills may use temp directories/emulated paths, which do not prove physical USB unplug/write-failure behavior on all platforms.
- **Linux runtime prerequisites:** WebKitGTK/JavascriptCore native packages are required for runtime execution and can block `pnpm tauri:dev` until installed.
- **Security hardening still open:** final memory/logging bridge audit and cross-platform removable-media adapter evidence are not yet complete, so avoid production readiness claims.
