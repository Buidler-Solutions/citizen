# Browser Extension

The Citizen browser extension is a focused signer-keeper for in-browser dApp interactions.

## Installation

### From Source

```bash
cd wallet/browser
npm install
npm run build
```

Load the `dist/` directory as an unpacked extension:

=== "Chrome"
    1. Navigate to `chrome://extensions`
    2. Enable **Developer mode** (top right)
    3. Click **Load unpacked**
    4. Select the `dist/` directory

=== "Firefox"
    1. Navigate to `about:debugging#/runtime/this-firefox`
    2. Click **Load Temporary Add-on**
    3. Select `dist/manifest.json`

## Features

### Wallet Management
- Generate new wallets (BIP39 mnemonic)
- Import existing wallets from mnemonic or private key
- Switch between multiple wallets
- View signer and reader DIDs

### dApp Interactions
- **dApp login** — challenge/verify authentication flow
- **Signing requests** — approve or reject transaction signing
- **Content script injection** — enables web dApps to communicate with the wallet
- **Request queue** — isolated, serialized request handling

### Decryption
- Hybrid decryption of owned transactions (X25519 ECDH + ChaCha20-Poly1305)
- Reader/signer credential display

### Direct Submit
- Submit signed entries directly to Citizen network endpoints
- Submit destinations are enforce-allowlisted

## Architecture

The extension uses a content-script/background-script architecture:

- **Content script** (`content.ts`) — injected into web pages, provides the Citizen provider API
- **Background script** (`background.ts`) — manages wallet state, handles signing requests
- **Popup** (`App.tsx`) — user interface for wallet operations

## dApp Login Flow

The browser extension supports challenge/verify authentication for dApps:

1. dApp requests a challenge from its backend
2. dApp asks the wallet to sign the challenge
3. Wallet signs with the user's Ed25519 signer key
4. dApp sends the signature to its backend for verification
5. Backend verifies the signature against the user's public key

This flow is powered by the `wallet/backend` service and the `sdk/typescript-auth` SDK.
