# Desktop Wallet

The Citizen desktop wallet is a Tauri-based application for macOS, Linux, and Windows with a Rust bridge for backup vault operations.

## Installation

### From Source

```bash
cd wallet/desktop
npm install
npm run tauri dev    # Development
npm run tauri build  # Production build
```

### Prerequisites

- Rust toolchain (for the Tauri Rust bridge)
- Node.js 22+
- Platform-specific dependencies:
    - **macOS**: Xcode Command Line Tools
    - **Linux**: `webkit2gtk`, `libgtk-3`, `libappindicator`
    - **Windows**: WebView2 runtime

## Features

### Backup Vault Operations

The desktop wallet's key differentiator is the **Rust backup vault bridge**, which provides:

- Encrypted wallet export (AES-256-GCM with PBKDF2 210K iterations)
- Backup vault import and verification
- Schema-validated backup format (`backup-command-envelope.v1.schema.json`)
- Disaster recovery support

### Standard Wallet Features

- Wallet creation and import (BIP39 mnemonic)
- Transaction signing
- Hybrid decryption
- Direct submit to Citizen network endpoints

## Architecture

```
wallet/desktop/
  src/                    # React frontend (UI)
  src-tauri/
    src/
      main.rs             # Tauri entry point
      backup_bridge.rs    # Backup vault Rust bridge
      backup_core_bridge.rs  # Core backup operations
    Cargo.toml            # Rust dependencies
    tauri.conf.json       # Tauri configuration
  scripts/                # Release gate, audit, and smoke scripts
```

The Rust bridge (`backup_bridge.rs`) handles the cryptographic operations for backup vault encryption and decryption, keeping sensitive operations in the compiled Rust layer rather than the JavaScript frontend.

## Release Process

The desktop wallet includes a comprehensive release gate with:

- TV3 audit scripts (portable smoke, evidence packs, completion gates)
- Desktop CLI compatibility matrix checks
- Alpha/beta promotion thresholds
- UX signoff completion guidelines
