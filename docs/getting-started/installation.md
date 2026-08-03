# Installation

## Prerequisites

### Rust Toolchain (Protocol Node)

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
rustup default stable
```

**Required:** Rust 1.75+ (check with `rustc --version`)

### Node.js (SDK, Wallet, Explorer)

```bash
# Via nvm (recommended)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
nvm install 22
nvm use 22
```

**Required:** Node.js 22+

### Flutter (Mobile Wallet)

```bash
# macOS
brew install --cask flutter

# Linux
snap install flutter --classic
```

**Required:** Flutter SDK 3.12+

## Build the Protocol

```bash
cd citizen-protocol
cargo check        # Verify compilation
cargo build --release
```

The node binary will be at `target/release/citizen-node`.

## Install the TypeScript SDK

```bash
cd sdk/typescript
npm install
npm run build
```

## Set Up a Wallet

Choose your surface:

=== "Mobile (Flutter)"
    ```bash
    cd wallet/mobile
    flutter pub get
    flutter run
    ```

=== "Browser Extension"
    ```bash
    cd wallet/browser
    npm install
    npm run build
    # Load dist/ as unpacked extension in Chrome/Firefox
    ```

=== "Desktop (Tauri)"
    ```bash
    cd wallet/desktop
    npm install
    npm run tauri dev
    ```

=== "CLI"
    ```bash
    cd citizen-protocol
    cargo build --release -p citizen-wallet-cli
    ./target/release/citizen-wallet-cli
    ```

## Verify Your Installation

```bash
# Protocol compiles
cd citizen-protocol && cargo test

# SDK builds
cd sdk/typescript && npm test

# Explorer builds
cd explorer/frontend && npm install && npm run build
```

## Troubleshooting

### Rust: `error: linker 'cc' not found`

Install a C compiler:

=== "Ubuntu/Debian"
    ```bash
    sudo apt install build-essential
    ```

=== "macOS"
    ```bash
    xcode-select --install
    ```

=== "Fedora/RHEL"
    ```bash
    sudo dnf install gcc
    ```

### Node.js: `npm ERR! ERESOLVE`

Use legacy peer deps resolution:

```bash
npm install --legacy-peer-deps
```

### Flutter: `Flutter SDK not found`

Ensure Flutter is in your PATH:

```bash
export PATH="$PATH:/path/to/flutter/bin"
```
