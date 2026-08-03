# Wallet Overview

Citizen provides multiple wallet surfaces, all sharing the same cryptographic derivation chain for cross-platform key compatibility.

## Available Wallets

| Wallet | Platform | Best For |
|--------|----------|----------|
| **Mobile** | iOS, Android | Everyday users, WalletConnect dApp pairing |
| **Browser Extension** | Chrome, Firefox | Web dApp interactions, in-browser signing |
| **Desktop** | macOS, Linux, Windows | Power users, backup vault operations |
| **CLI** | Terminal | Operators, developers, automation |
| **React Console** | Web | Onboarding, governance UX, namespace operations |

## Crypto Parity

All wallet surfaces derive identical keys from the same mnemonic:

```
BIP39 mnemonic → PBKDF2-HMAC-SHA512 (2048 iters) seed → SLIP-0010 m/44'/930'/0'/0'/0'
                                                                        │
                                                  ┌───────────────────────┴───────────────────────┐
                                                  ▼                                               ▼
                                          Ed25519 signer                                 X25519 reader
                                          (did:key:ed25519:)                             (did:key:x25519:)
                                          Transaction signing                            Data decryption
```

A mnemonic imported on any surface (CLI, browser, mobile, desktop) derives the same Ed25519/X25519 key material.

## Choosing a Wallet

### For everyday users
Use the **mobile wallet** — it provides the most user-friendly experience with QR-based WalletConnect pairing, secure platform key storage, and a 7-tab interface.

### For dApp developers
Use the **browser extension** — it provides dedicated in-browser signing, dApp login flows, and content-script injection for web dApps.

### For operators and power users
Use the **desktop wallet** for backup vault operations, or the **CLI wallet** for scripting and automation.

### For governance participants
Use the **React console** — it provides onboarding flows, operation builders, receipt inspection, and governance UX.

## Key Features Across Wallets

| Feature | Mobile | Browser | Desktop | CLI |
|---------|--------|---------|---------|-----|
| Wallet creation (12/24 word) | ✅ | ✅ | ✅ | ✅ |
| Wallet import | ✅ | ✅ | ✅ | ✅ |
| Transaction signing | ✅ | ✅ | ✅ | ✅ |
| Hybrid decryption | ✅ | ✅ | ✅ | ✅ |
| Direct submit | ✅ | ✅ | ✅ | ✅ |
| WalletConnect dApp pairing | ✅ | — | — | — |
| dApp login (challenge/verify) | — | ✅ | — | — |
| Backup vault operations | — | ✅ | ✅ | ✅ |
| Namespace signing helpers | — | — | — | ✅ |
| Secure platform storage | ✅ (Keychain/Keystore) | ✅ (Extension storage) | ✅ (OS keyring) | ✅ (File-based) |
